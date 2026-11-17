import { randomUUID } from "node:crypto";
import { chmod, lstat, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  addTodo,
  editTodo,
  listTodos,
  messageOf,
  normalizeNoteText,
  normalizeTaskText,
  noteTodo,
  removeTodo,
  toggleTodo,
  type TodoItem,
} from "../shared/todo";

type PaseoApi = PluginHandlerContext["paseo"];
type Project = Awaited<ReturnType<PaseoApi["projects"]["list"]>>["projects"][number];

const HOME_DIR = resolve(homedir());
const GLOBAL_FILE = join(HOME_DIR, "TODO.md");
const PASEO_HOME = join(HOME_DIR, ".paseo");
const CHECKBOX = /^(\s*[-*+]\s+\[)([ xX])(\]\s+)(.*?)$/;
const STALE_TASK = "This task changed on disk. Refresh and try again.";
const PROJECTS_TIMEOUT_MS = 10_000;

/** One physical line plus the exact line ending that followed it. */
type Line = { text: string; eol: string };

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Canonicalize a path for comparison (symlinks resolved). Missing paths fall
 * back to plain normalization so they can still be classified.
 */
function canonicalDir(path: string): Promise<string> {
  return realpath(path).catch(() => resolve(path));
}

let homeDirs: Promise<{ home: string; paseo: string }> | undefined;

function canonicalHomeDirs() {
  homeDirs ??= Promise.all([canonicalDir(HOME_DIR), canonicalDir(PASEO_HOME)]).then(
    ([home, paseo]) => ({ home, paseo }),
  );
  return homeDirs;
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return "";
    throw error;
  }
}

/**
 * Replace `path` through a temp file + `rename`, so a concurrent reader sees the
 * old file or the new one, never a partial one. Symlinks are resolved first so
 * the link's target is rewritten instead of the link. Keeps the permission
 * bits, and falls back to an in-place write when the temp file cannot be
 * created (read-only directory) or the path is a dangling symlink.
 */
async function writeText(path: string, content: string): Promise<void> {
  let target = path;
  try {
    target = await realpath(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    const link = await lstat(path).catch(() => null);
    if (link?.isSymbolicLink()) return writeFile(path, content, "utf8");
  }
  const mode = await stat(target).then(
    (info) => info.mode & 0o7777,
    () => undefined,
  );
  const temp = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    const code = errorCode(error);
    if (code === "EACCES" || code === "EPERM") return writeFile(target, content, "utf8");
    // The temp file may exist already (e.g. ENOSPC mid-write).
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
  try {
    // writeFile's `mode` option is filtered by umask, so set it explicitly.
    if (mode !== undefined) await chmod(temp, mode);
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

/** Split on `\r\n`, `\n` or `\r`, keeping each line's own terminator. */
function splitLines(source: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char !== "\n" && char !== "\r") continue;
    const eol = char === "\r" && source[i + 1] === "\n" ? "\r\n" : char;
    lines.push({ text: source.slice(start, i), eol });
    i += eol.length - 1;
    start = i + 1;
  }
  if (start < source.length) lines.push({ text: source.slice(start), eol: "" });
  return lines;
}

function joinLines(lines: Line[]): string {
  return lines.map((line) => line.text + line.eol).join("");
}

/**
 * Indented lines under a task are its note block. Whitespace-only lines are
 * absorbed (they contribute no text but are rewritten with the block); without
 * that they'd strand the indented lines below them as invisible leftovers.
 * Indented checkboxes stay separate items, as before.
 */
function isNoteLine(text: string): boolean {
  return /^\s/.test(text) && !CHECKBOX.test(text);
}

/** The line after the note block that belongs to the task on line `line`. */
function noteBlockEnd(lines: Line[], line: number): number {
  let end = line + 1;
  while (end < lines.length && isNoteLine(lines[end].text)) end++;
  return end;
}

/**
 * The note text of an indented line. Checkbox-shaped notes are written with a
 * zero-width space after the indent (see noteTodoHandler); it is not
 * whitespace, so trim() keeps it and it is dropped here to round-trip.
 */
function noteText(text: string): string {
  const trimmed = text.trim();
  return trimmed.startsWith("\u200B") ? trimmed.slice(1) : trimmed;
}

function parseItems(source: string): TodoItem[] {
  const items: TodoItem[] = [];
  const lines = splitLines(source);
  for (let i = 0; i < lines.length; i++) {
    const match = CHECKBOX.exec(lines[i].text);
    if (!match) continue;
    const note: string[] = [];
    while (i + 1 < lines.length && isNoteLine(lines[i + 1].text)) {
      const text = noteText(lines[++i].text);
      if (text) note.push(text);
    }
    items.push({
      index: items.length,
      text: match[4].trim(),
      done: match[2] !== " ",
      note: note.join("\n"),
    });
  }
  return items;
}

/**
 * Find the physical line of item `index`, refusing to act when that item no
 * longer has the text the client saw (the file changed since its last poll).
 */
function locateLine(lines: Line[], index: number, text: string) {
  let seen = 0;
  for (let line = 0; line < lines.length; line++) {
    const match = CHECKBOX.exec(lines[line].text);
    if (!match || seen++ !== index) continue;
    if (match[4].trim() !== text) break;
    return { line, match };
  }
  throw new Error(STALE_TASK);
}

/** The file's most common line ending; `\n` when there are none yet. */
function dominantEol(lines: Line[]): string {
  const counts = new Map<string, number>();
  for (const { eol } of lines) {
    if (eol) counts.set(eol, (counts.get(eol) ?? 0) + 1);
  }
  let best = "\n";
  let bestCount = 0;
  for (const [eol, count] of counts) {
    if (count > bestCount) {
      best = eol;
      bestCount = count;
    }
  }
  return best;
}

function projectLabel(project: Project): string {
  return project.projectCustomName ?? project.projectDisplayName;
}

async function resolvePath(paseo: PaseoApi, projectId: string | null): Promise<string> {
  if (!projectId) return GLOBAL_FILE;
  // Bounded so a hung daemon call cannot stall the mutation queue forever.
  const { projects } = await withTimeout(
    paseo.projects.list(),
    PROJECTS_TIMEOUT_MS,
    "Timed out looking up the project",
  );
  const project = projects.find((item) => item.projectId === projectId);
  const canonical = project?.projectRootPath
    ? await canonicalDir(project.projectRootPath)
    : "";
  const { home, paseo: paseoHome } = await canonicalHomeDirs();
  // A workspace rooted at `~` (or a symlink to it) uses the global list.
  if (canonical === home) return GLOBAL_FILE;
  // `~/.paseo` is Paseo's own home; neither it nor an unknown root is a project.
  if (!project || canonical === "" || canonical === paseoHome) {
    throw new Error("Project not found");
  }
  return join(project.projectRootPath, "TODO.md");
}

/**
 * All mutations run one at a time, in call order. Each one is a
 * read-modify-write of a TODO.md, so interleaving two of them (even through
 * different project ids aliasing the same file) would silently drop a change.
 */
let mutationQueue: Promise<unknown> = Promise.resolve();

/** `transform` returns the new content, or `null` to leave the file untouched. */
function mutateTodoFile(
  paseo: PaseoApi,
  projectId: string | null,
  transform: (existing: string) => string | null,
): Promise<{ ok: boolean }> {
  const run = mutationQueue.then(async () => {
    const path = await resolvePath(paseo, projectId);
    const next = transform(await readText(path));
    if (next !== null) await writeText(path, next);
    return { ok: true };
  });
  mutationQueue = run.catch(() => {});
  return run;
}

export async function listTodosHandler(
  _input: RpcInput<typeof listTodos>,
  { paseo }: PluginHandlerContext,
) {
  const [{ projects }, { entries }] = await Promise.all([
    withTimeout(paseo.projects.list(), PROJECTS_TIMEOUT_MS, "Timed out listing projects"),
    withTimeout(paseo.workspaces.list(), PROJECTS_TIMEOUT_MS, "Timed out listing workspaces"),
  ]);

  const activeWorkspaceByProject = new Map<string, string>();
  for (const entry of entries) {
    if (entry.archivingAt || entry.internal || entry.background) continue;
    if (!activeWorkspaceByProject.has(entry.projectId)) {
      activeWorkspaceByProject.set(entry.projectId, entry.id);
    }
  }

  // Files that fail to read degrade to an empty list carrying the error,
  // so one bad TODO.md cannot take down every other list.
  type FileItems = { items: TodoItem[]; error?: string };
  const reads = new Map<string, Promise<FileItems>>();
  const loadItems = (path: string): Promise<FileItems> => {
    let pending = reads.get(path);
    if (!pending) {
      pending = readText(path)
        .then((source): FileItems => ({ items: parseItems(source) }))
        .catch((error: unknown): FileItems => ({ items: [], error: messageOf(error) }));
      reads.set(path, pending);
    }
    return pending;
  };

  const { home, paseo: paseoHome } = await canonicalHomeDirs();
  const classified = await Promise.all(
    projects.map(async (project) => {
      const canonical = project.projectRootPath
        ? await canonicalDir(project.projectRootPath)
        : "";
      return { project, canonical };
    }),
  );
  const valid = classified.filter(
    ({ canonical }) => canonical !== "" && canonical !== home && canonical !== paseoHome,
  );
  const homeProjectIds = classified
    .filter(({ canonical }) => canonical === home)
    .map(({ project }) => project.projectId);

  const validProjects = valid
    .map(({ project }) => project)
    .sort((a, b) => {
      const aActive = activeWorkspaceByProject.has(a.projectId) ? 0 : 1;
      const bActive = activeWorkspaceByProject.has(b.projectId) ? 0 : 1;
      return aActive - bActive || projectLabel(a).localeCompare(projectLabel(b));
    });

  const [globalLoad, projectFiles] = await Promise.all([
    loadItems(GLOBAL_FILE),
    Promise.all(
      validProjects.map(async (project) => {
        const path = join(project.projectRootPath, "TODO.md");
        const loaded = await loadItems(path);
        return {
          projectId: project.projectId,
          workspaceId: activeWorkspaceByProject.get(project.projectId) ?? null,
          label: projectLabel(project),
          path,
          items: loaded.items,
          error: loaded.error,
        };
      }),
    ),
  ]);

  return {
    global: {
      projectId: null,
      workspaceId: null,
      label: "Global",
      path: GLOBAL_FILE,
      items: globalLoad.items,
      error: globalLoad.error,
    },
    projects: projectFiles,
    homeProjectIds,
  };
}

export async function addTodoHandler(
  { projectId, text }: RpcInput<typeof addTodo>,
  { paseo }: PluginHandlerContext,
) {
  // A task is one line; embedded newlines would otherwise inject extra items.
  // U+2028/U+2029 count too: CHECKBOX's `.` does not match them.
  const task = normalizeTaskText(text);
  if (!task) throw new Error("Task text cannot be empty");
  return mutateTodoFile(paseo, projectId, (existing) => {
    const lines = splitLines(existing);
    const last = lines[lines.length - 1];
    // Reuse the last line's ending, else the file's dominant one (`\n` if empty).
    const eol = last?.eol || dominantEol(lines);
    const separator = last && !last.eol ? eol : "";
    return `${existing}${separator}- [ ] ${task}${eol}`;
  });
}

export async function toggleTodoHandler(
  { projectId, index, text }: RpcInput<typeof toggleTodo>,
  { paseo }: PluginHandlerContext,
) {
  return mutateTodoFile(paseo, projectId, (existing) => {
    const lines = splitLines(existing);
    const { line, match } = locateLine(lines, index, text);
    lines[line].text = `${match[1]}${match[2] === " " ? "x" : " "}${match[3]}${match[4]}`;
    return joinLines(lines);
  });
}

export async function editTodoHandler(
  { projectId, index, text, newText }: RpcInput<typeof editTodo>,
  { paseo }: PluginHandlerContext,
) {
  const task = normalizeTaskText(newText);
  if (!task) throw new Error("Task text cannot be empty");
  return mutateTodoFile(paseo, projectId, (existing) => {
    const lines = splitLines(existing);
    const { line, match } = locateLine(lines, index, text);
    if (match[4].trim() === task) return null; // No-op edit leaves the file alone.
    lines[line].text = `${match[1]}${match[2]}${match[3]}${task}`;
    return joinLines(lines);
  });
}

export async function noteTodoHandler(
  { projectId, index, text, note }: RpcInput<typeof noteTodo>,
  { paseo }: PluginHandlerContext,
) {
  const next = normalizeNoteText(note);
  return mutateTodoFile(paseo, projectId, (existing) => {
    const lines = splitLines(existing);
    const { line } = locateLine(lines, index, text);
    const end = noteBlockEnd(lines, line);
    const current = lines
      .slice(line + 1, end)
      .map((entry) => noteText(entry.text))
      .filter(Boolean)
      .join("\n");
    if (current === next) return null; // No-op leaves the file alone.
    if (!next) {
      lines.splice(line + 1, end - line - 1);
      return joinLines(lines);
    }
    // Reuse the task's own indent + line ending; an unterminated task line gets
    // the file's dominant ending so the note lines can follow it. Indents only
    // ever inherit plain spaces/tabs, not exotic whitespace.
    const indent = `${lines[line].text.match(/^[ \t]*/)![0]}  `;
    const eol = lines[line].eol || dominantEol(lines);
    if (!lines[line].eol) lines[line].eol = eol;
    lines.splice(
      line + 1,
      end - line - 1,
      ...next.split("\n").map((noteLine) => {
        const text = `${indent}${noteLine}`;
        // A note shaped like a checkbox ("- [ ] …") would re-parse as a real
        // task. A zero-width space is invisible, is not `\s` (so CHECKBOX
        // fails), and noteText() drops it again on read.
        return { text: CHECKBOX.test(text) ? `${indent}\u200B${noteLine}` : text, eol };
      }),
    );
    return joinLines(lines);
  });
}

export async function removeTodoHandler(
  { projectId, index, text }: RpcInput<typeof removeTodo>,
  { paseo }: PluginHandlerContext,
) {
  return mutateTodoFile(paseo, projectId, (existing) => {
    const lines = splitLines(existing);
    const { line } = locateLine(lines, index, text);
    // A removed task takes the indented note lines under it along.
    lines.splice(line, noteBlockEnd(lines, line) - line);
    return joinLines(lines);
  });
}
