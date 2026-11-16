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
  normalizeTaskText,
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

function parseItems(source: string): TodoItem[] {
  let index = 0;
  return splitLines(source).flatMap((line) => {
    const match = CHECKBOX.exec(line.text);
    if (!match) return [];
    return [{ index: index++, text: match[4].trim(), done: match[2] !== " " }];
  });
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

/** `~` is the global file and `~/.paseo` is Paseo's own home; neither is a project. */
function isProjectRoot(root: string): boolean {
  if (!root) return false;
  const normalized = resolve(root);
  return normalized !== HOME_DIR && normalized !== PASEO_HOME;
}

function projectLabel(project: Project): string {
  return project.projectCustomName ?? project.projectDisplayName;
}

async function resolvePath(paseo: PaseoApi, projectId: string | null): Promise<string> {
  if (!projectId) return GLOBAL_FILE;
  // Bounded so a hung daemon call cannot stall the mutation queue forever.
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Timed out looking up the project")),
      PROJECTS_TIMEOUT_MS,
    );
  });
  const { projects } = await Promise.race([paseo.projects.list(), timeout]).finally(() =>
    clearTimeout(timer),
  );
  const project = projects.find((item) => item.projectId === projectId);
  // A workspace rooted at `~` uses the global list, as in the Explorer panel.
  if (project?.projectRootPath && resolve(project.projectRootPath) === HOME_DIR) {
    return GLOBAL_FILE;
  }
  if (!project || !isProjectRoot(project.projectRootPath)) {
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
    paseo.projects.list(),
    paseo.workspaces.list(),
  ]);

  const activeWorkspaceByProject = new Map<string, string>();
  for (const entry of entries) {
    if (entry.archivingAt || entry.internal || entry.background) continue;
    if (!activeWorkspaceByProject.has(entry.projectId)) {
      activeWorkspaceByProject.set(entry.projectId, entry.id);
    }
  }

  // Projects sharing a root share one read.
  const reads = new Map<string, Promise<TodoItem[]>>();
  const loadItems = (path: string) => {
    let pending = reads.get(path);
    if (!pending) {
      pending = readText(path).then(parseItems);
      reads.set(path, pending);
    }
    return pending;
  };

  const validProjects = projects
    .filter((project) => isProjectRoot(project.projectRootPath))
    .sort((a, b) => {
      const aActive = activeWorkspaceByProject.has(a.projectId) ? 0 : 1;
      const bActive = activeWorkspaceByProject.has(b.projectId) ? 0 : 1;
      return aActive - bActive || projectLabel(a).localeCompare(projectLabel(b));
    });

  const [globalItems, projectFiles] = await Promise.all([
    loadItems(GLOBAL_FILE),
    Promise.all(
      validProjects.map(async (project) => {
        const path = join(project.projectRootPath, "TODO.md");
        return {
          projectId: project.projectId,
          workspaceId: activeWorkspaceByProject.get(project.projectId) ?? null,
          label: projectLabel(project),
          path,
          items: await loadItems(path),
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
      items: globalItems,
    },
    projects: projectFiles,
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
    // Reuse the file's own line ending; default to `\n` for an empty file.
    const eol = last?.eol || /\r\n|\n|\r/.exec(existing)?.[0] || "\n";
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

export async function removeTodoHandler(
  { projectId, index, text }: RpcInput<typeof removeTodo>,
  { paseo }: PluginHandlerContext,
) {
  return mutateTodoFile(paseo, projectId, (existing) => {
    const lines = splitLines(existing);
    // Without `index`, clear every completed item; a no-op leaves the file alone.
    const target = index === undefined ? null : locateLine(lines, index, text ?? "").line;
    const next = lines.filter((line, lineIndex) => {
      if (target !== null) return lineIndex !== target;
      const match = CHECKBOX.exec(line.text);
      return !match || match[2] === " ";
    });
    return next.length === lines.length ? null : joinLines(next);
  });
}
