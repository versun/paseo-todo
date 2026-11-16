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

const GLOBAL_FILE = join(homedir(), "TODO.md");
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

async function resolvePath(paseo: PaseoApi, workspaceId: string | null): Promise<string> {
  if (!workspaceId) return GLOBAL_FILE;
  const { entries } = await paseo.workspaces.list();
  const entry = entries.find((item) => item.id === workspaceId);
  if (!entry?.workspaceDirectory) throw new Error("Workspace not found");
  return join(entry.workspaceDirectory, "TODO.md");
}

export async function listTodosHandler(
  _input: RpcInput<typeof listTodos>,
  { paseo }: PluginHandlerContext,
) {
  const { entries } = await paseo.workspaces.list();
  const cache = new Map<string, Promise<TodoItem[]>>();
  const loadItems = (path: string) => {
    let pending = cache.get(path);
    if (!pending) {
      pending = readText(path).then(parseItems);
      cache.set(path, pending);
    }
    return pending;
  };

  const active = entries.filter(
    (entry) =>
      Boolean(entry.workspaceDirectory) &&
      !entry.archivingAt &&
      !entry.internal &&
      !entry.background,
  );

  const [globalItems, workspaces] = await Promise.all([
    loadItems(GLOBAL_FILE),
    Promise.all(
      active.map(async (entry) => {
        const path = join(entry.workspaceDirectory!, "TODO.md");
        return {
          workspaceId: entry.id,
          label: entry.title ?? entry.name,
          project: entry.projectDisplayName || null,
          path,
          items: await loadItems(path),
        };
      }),
    ),
  ]);

  return {
    global: {
      workspaceId: null,
      label: "Inbox",
      project: null,
      path: GLOBAL_FILE,
      items: globalItems,
    },
    workspaces,
  };
}

export async function addTodoHandler(
  { workspaceId, text }: RpcInput<typeof addTodo>,
  { paseo }: PluginHandlerContext,
) {
  const path = await resolvePath(paseo, workspaceId);
  const existing = await readText(path);
  const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
  await writeFile(path, `${existing}${separator}- [ ] ${text}\n`, "utf8");
  return { ok: true };
}

export async function toggleTodoHandler(
  { workspaceId, index }: RpcInput<typeof toggleTodo>,
  { paseo }: PluginHandlerContext,
) {
  const path = await resolvePath(paseo, workspaceId);
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
  { workspaceId, index }: RpcInput<typeof removeTodo>,
  { paseo }: PluginHandlerContext,
) {
  const path = await resolvePath(paseo, workspaceId);
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
