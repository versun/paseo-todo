import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const todoItemSchema = z.object({
  index: z.number().int().nonnegative(),
  text: z.string(),
  done: z.boolean(),
});

const todoFileSchema = z.object({
  /** `null` for the global ~/TODO.md. */
  projectId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  label: z.string(),
  path: z.string(),
  items: z.array(todoItemSchema),
});

export type TodoItem = z.infer<typeof todoItemSchema>;
export type TodoFile = z.infer<typeof todoFileSchema>;
export type TodoListData = z.infer<typeof listTodos.output>;

/** Collapse any embedded line breaks so a task is always a single Markdown line. */
export function normalizeTaskText(text: string): string {
  return text.replace(/\s*[\r\n\u2028\u2029]+\s*/g, " ").trim();
}

export const listTodos = defineRpc({
  name: "todo.list",
  input: z.object({}),
  output: z.object({
    global: todoFileSchema,
    projects: z.array(todoFileSchema),
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

export const removeTodo = defineRpc({
  name: "todo.remove",
  input: z
    .object({
      projectId: z.string().nullable(),
      /** Omit `index` to clear all completed items in the target file. */
      index: z.number().int().nonnegative().optional(),
      /** Required with `index`: the item text the client last saw. */
      text: z.string().optional(),
    })
    .refine((value) => value.index === undefined || value.text !== undefined, {
      message: "text is required when index is provided",
      path: ["text"],
    }),
  output: z.object({ ok: z.boolean() }),
});
