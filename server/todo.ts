import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  addTodo,
  listTodos,
  removeTodo,
  toggleTodo,
  type TodoItem,
} from "../shared/todo";

const HOME_DIR = homedir();
const GLOBAL_FILE = join(HOME_DIR, "TODO.md");
const PASEO_HOME = join(HOME_DIR, ".paseo");
const CHECKBOX = /^(\s*[-*+]\s+\[)([ xX])(\]\s+(.*?))\r?$/;

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function parseItems(text: string): TodoItem[] {
  let index = 0;
  return text.split(/\r?\n/).flatMap((line) => {
    const match = CHECKBOX.exec(line);
    if (!match) return [];
    return [{ index: index++, text: match[4].trim(), done: match[2] !== " " }];
  });
}

async function resolvePath(paseo: PaseoApi, projectId: string | null): Promise<string> {
  if (!projectId) return GLOBAL_FILE;
  const { projects } = await paseo.projects.list();
  const project = projects.find((item) => item.projectId === projectId);
  if (!project?.projectRootPath) throw new Error("Project not found");
  return join(project.projectRootPath, "TODO.md");
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

  const cache = new Map<string, Promise<TodoItem[]>>();
  const loadItems = (path: string) => {
    let pending = cache.get(path);
    if (!pending) {
      pending = readText(path).then(parseItems);
      cache.set(path, pending);
    }
    return pending;
  };

  const validProjects = projects
    .filter(
      (project) =>
        Boolean(project.projectRootPath) &&
        project.projectRootPath !== HOME_DIR &&
        project.projectRootPath !== PASEO_HOME,
    )
    .sort((a, b) => {
      const aActive = activeWorkspaceByProject.has(a.projectId) ? 0 : 1;
      const bActive = activeWorkspaceByProject.has(b.projectId) ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      const aLabel = a.projectCustomName ?? a.projectDisplayName;
      const bLabel = b.projectCustomName ?? b.projectDisplayName;
      return aLabel.localeCompare(bLabel);
    });

  const [globalItems, projectFiles] = await Promise.all([
    loadItems(GLOBAL_FILE),
    Promise.all(
      validProjects.map(async (project) => {
        const path = join(project.projectRootPath, "TODO.md");
        return {
          projectId: project.projectId,
          workspaceId: activeWorkspaceByProject.get(project.projectId) ?? null,
          label: project.projectCustomName ?? project.projectDisplayName,
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
  const path = await resolvePath(paseo, projectId);
  const existing = await readText(path);
  const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
  await writeFile(path, `${existing}${separator}- [ ] ${text}\n`, "utf8");
  return { ok: true };
}

export async function toggleTodoHandler(
  { projectId, index }: RpcInput<typeof toggleTodo>,
  { paseo }: PluginHandlerContext,
) {
  const path = await resolvePath(paseo, projectId);
  let seen = 0;
  const next = (await readText(path))
    .split(/\r?\n/)
    .map((line) => {
      const match = CHECKBOX.exec(line);
      if (!match || seen++ !== index) return line;
      return `${match[1]}${match[2] === " " ? "x" : " "}${match[3]}`;
    })
    .join("\n");
  await writeFile(path, next, "utf8");
  return { ok: true };
}

export async function removeTodoHandler(
  { projectId, index }: RpcInput<typeof removeTodo>,
  { paseo }: PluginHandlerContext,
) {
  const path = await resolvePath(paseo, projectId);
  const existing = await readText(path);
  if (!existing) return { ok: true };
  let seen = 0;
  const next = existing
    .split(/\r?\n/)
    .filter((line) => {
      const match = CHECKBOX.exec(line);
      if (!match) return true;
      const current = seen++;
      return index !== undefined ? current !== index : match[2] === " ";
    })
    .join("\n");
  await writeFile(path, next, "utf8");
  return { ok: true };
}
