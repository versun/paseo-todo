import type { PluginClientContext } from "@getpaseo/plugin/client";
import { TodoScreen, TodoSidebarItem, WorkspaceTodosPanel } from "./client/todo";
import { addTodo } from "./shared/todo";

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
  client.addCommandCenterItem({
    id: "open-todos-screen",
    title: "Open TODO",
    icon: "ListTodo",
    keywords: ["todo", "tasks", "checklist"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: "todos" });
    },
  });
  client.addCommandCenterItem({
    id: "open-workspace-todos",
    title: "Open workspace TODO",
    icon: "ListTodo",
    keywords: ["todo", "tasks", "checklist"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("todos", { location: "explorer" });
    },
  });
  client.addSlashCommand({
    name: "todo",
    description: "Add a todo or open the workspace TODO panel",
    argumentHint: "[task]",
    context: "workspace",
    async onSubmit({ args, workspace, rpc, openPanel }) {
      const text = args.trim();
      if (text) {
        await rpc(addTodo, { projectId: workspace.projectId, text });
      }
      openPanel("todos", { location: "explorer" });
    },
  });
  return () => {};
}
