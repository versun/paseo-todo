import type { PluginClientContext } from "@getpaseo/plugin/client";
import { TodoScreen, TodoSidebarItem, WorkspaceTodosPanel } from "./client/todo";

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "todos", title: "TODO", Component: TodoScreen });
  client.addSidebarHeaderItem({ id: "todos", title: "TODO", Component: TodoSidebarItem });
  client.addWorkspacePanel({
    id: "todos",
    title: "TODO",
    icon: "ListTodo",
    locations: ["explorer"],
    Component: WorkspaceTodosPanel,
  });
  return () => {};
}
