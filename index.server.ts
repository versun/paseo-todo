import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  addTodoHandler,
  editTodoHandler,
  listTodosHandler,
  noteTodoHandler,
  removeTodoHandler,
  toggleTodoHandler,
} from "./server/todo";
import { addTodo, editTodo, listTodos, noteTodo, removeTodo, toggleTodo } from "./shared/todo";

export default function contribute(server: PluginServerContext) {
  server.handle(listTodos, listTodosHandler);
  server.handle(addTodo, addTodoHandler);
  server.handle(toggleTodo, toggleTodoHandler);
  server.handle(editTodo, editTodoHandler);
  server.handle(noteTodo, noteTodoHandler);
  server.handle(removeTodo, removeTodoHandler);
  return () => {};
}
