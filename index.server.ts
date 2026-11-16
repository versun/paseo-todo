import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  addTodoHandler,
  editTodoHandler,
  listTodosHandler,
  removeTodoHandler,
  toggleTodoHandler,
} from "./server/todo";
import { addTodo, editTodo, listTodos, removeTodo, toggleTodo } from "./shared/todo";

export default function contribute(server: PluginServerContext) {
  server.handle(listTodos, listTodosHandler);
  server.handle(addTodo, addTodoHandler);
  server.handle(toggleTodo, toggleTodoHandler);
  server.handle(editTodo, editTodoHandler);
  server.handle(removeTodo, removeTodoHandler);
  return () => {};
}
