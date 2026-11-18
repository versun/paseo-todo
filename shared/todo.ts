import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const todoItemSchema = z.object({
  index: z.number().int().nonnegative(),
  text: z.string(),
  done: z.boolean(),
  /** Extra notes for the task; stored as indented lines under it. */
  note: z.string(),
  /** Bound workspace id and display label, stored as a leading Markdown link in the note block. */
  workspaceId: z.string().nullable(),
  workspaceLabel: z.string().nullable(),
});

const todoFileSchema = z.object({
  /** `null` for the global ~/TODO.md. */
  projectId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  label: z.string(),
  path: z.string(),
  items: z.array(todoItemSchema),
  /** Set when the file exists but could not be read; `items` is empty then. */
  error: z.string().optional(),
});

export type TodoItem = z.infer<typeof todoItemSchema>;
export type TodoFile = z.infer<typeof todoFileSchema>;
export type TodoListData = z.infer<typeof listTodos.output>;

/** Collapse any embedded line breaks so a task is always a single Markdown line. */
export function normalizeTaskText(text: string): string {
  return text.replace(/\s*[\r\n\u2028\u2029]+\s*/g, " ").trim();
}

/** Notes keep their line breaks; each line is written indented under the task. */
export function normalizeNoteText(text: string): string {
  return text
    .split(/\r\n|[\n\r\u2028\u2029]/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Files shown on the main TODO screen: the global list always, and only
 * projects that have at least one task. Taskless projects stay available as
 * add targets and reappear once their first task lands.
 */
export function visibleTodoFiles(data: TodoListData): TodoFile[] {
  return [
    data.global,
    ...data.projects.filter((file) => file.items.length > 0 || file.error !== undefined),
  ];
}

export const listTodos = defineRpc({
  name: "todo.list",
  input: z.object({}),
  output: z.object({
    global: todoFileSchema,
    projects: z.array(todoFileSchema),
    /** Ids of projects whose root resolves to `~`; their tasks live in `global`. */
    homeProjectIds: z.array(z.string()),
  }),
});

export const addTodo = defineRpc({
  name: "todo.add",
  input: z.object({
    projectId: z.string().nullable(),
    text: z.string().trim().min(1),
  }),
  output: z.object({ ok: z.boolean() }),
});

/**
 * `text` is the item content the client last saw. The server compares it before
 * mutating so a stale `index` (the file changed since the last poll) can never
 * toggle or delete the wrong task.
 */
export const toggleTodo = defineRpc({
  name: "todo.toggle",
  input: z.object({
    projectId: z.string().nullable(),
    index: z.number().int().nonnegative(),
    text: z.string(),
  }),
  output: z.object({ ok: z.boolean() }),
});

export const editTodo = defineRpc({
  name: "todo.edit",
  input: z.object({
    projectId: z.string().nullable(),
    index: z.number().int().nonnegative(),
    /** The item text the client last saw; mismatches are refused like toggle/remove. */
    text: z.string(),
    newText: z.string().trim().min(1),
  }),
  output: z.object({ ok: z.boolean() }),
});

/**
 * Replaces the task's note (an empty `note` clears it). `text` is the same
 * stale-index guard used by toggle/edit/remove.
 */
export const noteTodo = defineRpc({
  name: "todo.note",
  input: z.object({
    projectId: z.string().nullable(),
    index: z.number().int().nonnegative(),
    text: z.string(),
    note: z.string(),
  }),
  output: z.object({ ok: z.boolean() }),
});

/**
 * Binds or unbinds (`workspaceId: null`) a workspace on the task at `index`.
 * Stored as `[label](paseo:workspace:<id>)` at the top of the task's note
 * block. `text` is the same stale-index guard used by toggle/edit/note/remove.
 */
export const linkTodo = defineRpc({
  name: "todo.link",
  input: z.object({
    projectId: z.string().nullable(),
    index: z.number().int().nonnegative(),
    text: z.string(),
    workspaceId: z.string().trim().min(1).nullable(),
    workspaceLabel: z.string().nullable().optional(),
  }),
  output: z.object({ ok: z.boolean() }),
});

export const removeTodo = defineRpc({
  name: "todo.remove",
  input: z.object({
    projectId: z.string().nullable(),
    index: z.number().int().nonnegative(),
    /** The item text the client last saw; mismatches are refused like toggle/edit. */
    text: z.string(),
  }),
  output: z.object({ ok: z.boolean() }),
});

/**
 * Moves the item at `index` so it lands before the item at `toIndex` in the
 * destination list (pre-move numbering; `toIndex === items.length` appends).
 * Works within one file and across files; the task keeps its done state and
 * its indented note block. `text` is the same stale-index guard used by the
 * other mutations, checked against the item being moved.
 */
export const moveTodo = defineRpc({
  name: "todo.move",
  input: z.object({
    projectId: z.string().nullable(),
    index: z.number().int().nonnegative(),
    text: z.string(),
    toProjectId: z.string().nullable(),
    toIndex: z.number().int().nonnegative(),
  }),
  output: z.object({ ok: z.boolean() }),
});
