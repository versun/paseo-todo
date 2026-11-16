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

export const toggleTodo = defineRpc({
  name: "todo.toggle",
  input: z.object({
    projectId: z.string().nullable(),
    index: z.number().int().nonnegative(),
  }),
  output: z.object({ ok: z.boolean() }),
});

export const removeTodo = defineRpc({
  name: "todo.remove",
  input: z.object({
    projectId: z.string().nullable(),
    /** Omit `index` to clear all completed items in the target file. */
    index: z.number().int().nonnegative().optional(),
  }),
  output: z.object({ ok: z.boolean() }),
});
