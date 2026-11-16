import type {
  PluginScreenProps,
  PluginSidebarItemProps,
  PluginWorkspacePanelProps,
} from "@getpaseo/plugin/client";
import { useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { Icon, ScrollView, SidebarRow, TextInput } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import {
  addTodo,
  listTodos,
  removeTodo,
  toggleTodo,
  type TodoFile,
  type TodoItem,
  type TodoListData,
} from "../shared/todo";

const QUERY_KEY = ["todos"];

type TodoTheme = PluginScreenProps["theme"];
type FilterMode = "all" | "personal" | "workspaces";

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function reindex(items: TodoItem[]): TodoItem[] {
  return items.map((item, idx) => ({ ...item, index: idx }));
}

function updateMatchingFiles(
  data: TodoListData | undefined,
  workspaceId: string | null,
  updater: (items: TodoItem[]) => TodoItem[],
): TodoListData | undefined {
  if (!data) return data;
  const targetPath =
    workspaceId === null
      ? data.global.path
      : data.workspaces.find((item) => item.workspaceId === workspaceId)?.path;
  if (!targetPath) return data;
  const apply = (file: TodoFile): TodoFile =>
    file.path === targetPath ? { ...file, items: reindex(updater(file.items)) } : file;
  return {
    global: apply(data.global),
    workspaces: data.workspaces.map(apply),
  };
}

export function useTodos() {
  const list = useRpc(listTodos);
  const addRpc = useRpc(addTodo);
  const toggleRpc = useRpc(toggleTodo);
  const removeRpc = useRpc(removeTodo);
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => list({}),
    refetchInterval: 2000,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: QUERY_KEY });

  const addMutation = useMutation({
    mutationFn: addRpc,
    onMutate: async ({ workspaceId, text }) => {
      await queryClient.cancelQueries({ queryKey: QUERY_KEY });
      queryClient.setQueryData<TodoListData>(QUERY_KEY, (prev) =>
        updateMatchingFiles(prev, workspaceId, (items) => [
          ...items,
          { index: items.length, text, done: false },
        ]),
      );
    },
    onSettled: invalidate,
  });

  const toggleMutation = useMutation({
    mutationFn: toggleRpc,
    onMutate: async ({ workspaceId, index }) => {
      await queryClient.cancelQueries({ queryKey: QUERY_KEY });
      queryClient.setQueryData<TodoListData>(QUERY_KEY, (prev) =>
        updateMatchingFiles(prev, workspaceId, (items) =>
          items.map((item) => (item.index === index ? { ...item, done: !item.done } : item)),
        ),
      );
    },
    onSettled: invalidate,
  });

  const removeMutation = useMutation({
    mutationFn: removeRpc,
    onMutate: async ({ workspaceId, index }) => {
      await queryClient.cancelQueries({ queryKey: QUERY_KEY });
      queryClient.setQueryData<TodoListData>(QUERY_KEY, (prev) =>
        updateMatchingFiles(prev, workspaceId, (items) =>
          items.filter((item) => (index !== undefined ? item.index !== index : !item.done)),
        ),
      );
    },
    onSettled: invalidate,
  });

  return {
    data: query.data,
    error: query.error,
    add: (workspaceId: string | null, text: string) =>
      addMutation.mutateAsync({ workspaceId, text }),
    toggle: (workspaceId: string | null, index: number) =>
      toggleMutation.mutateAsync({ workspaceId, index }),
    remove: (workspaceId: string | null, index?: number) =>
      removeMutation.mutateAsync({ workspaceId, index }),
  };
}

type TodoActions = Pick<ReturnType<typeof useTodos>, "add" | "toggle" | "remove">;

function deduplicateFiles(data: TodoListData): TodoFile[] {
  return data.workspaces.filter(
    (file, index, all) =>
      file.path !== data.global.path && all.findIndex((item) => item.path === file.path) === index,
  );
}

export function TodoSidebarItem({ theme, currentScreen, openScreen }: PluginSidebarItemProps) {
  const { data } = useTodos();
  const openCount = data
    ? [data.global, ...deduplicateFiles(data)].reduce(
        (sum, file) => sum + file.items.filter((item) => !item.done).length,
        0,
      )
    : 0;

  return (
    <SidebarRow
      icon="ListTodo"
      active={currentScreen?.screenId === "todos"}
      onPress={() => openScreen({ screenId: "todos" })}
      trailing={
        openCount > 0 ? (
          <View style={[styles.sidebarBadge, { backgroundColor: theme.colors.surface2 }]}>
            <Text style={[styles.sidebarBadgeText, { color: theme.colors.foregroundMuted }]}>
              {openCount}
            </Text>
          </View>
        ) : undefined
      }
    />
  );
}

function TodoRow({
  item,
  last,
  theme,
  onToggle,
  onRemove,
}: {
  item: TodoItem;
  last: boolean;
  theme: TodoTheme;
  onToggle: () => void;
  onRemove: () => void;
}) {
  return (
    <View
      style={[
        styles.row,
        !last && {
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: theme.colors.border,
        },
      ]}
    >
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: item.done }}
        accessibilityLabel={item.text}
        onPress={onToggle}
        style={styles.rowMain}
      >
        <View
          style={[
            styles.checkbox,
            {
              borderColor: item.done ? theme.colors.accent : theme.colors.border,
              backgroundColor: item.done ? theme.colors.accent : theme.colors.surface0,
            },
          ]}
        >
          {item.done ? (
            <Icon name="Check" size={11} color={theme.colors.accentForeground} />
          ) : null}
        </View>
        <Text
          style={[
            styles.itemText,
            {
              color: item.done ? theme.colors.foregroundMuted : theme.colors.foreground,
              textDecorationLine: item.done ? "line-through" : "none",
            },
          ]}
        >
          {item.text}
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Delete ${item.text}`}
        hitSlop={8}
        onPress={onRemove}
        style={styles.deleteButton}
      >
        <Icon name="X" size={13} color={theme.colors.foregroundMuted} />
      </Pressable>
    </View>
  );
}

function TodoSection({
  file,
  theme,
  actions,
  compactHeader = false,
  onOpenWorkspace,
}: {
  file: TodoFile;
  theme: TodoTheme;
  actions: TodoActions;
  compactHeader?: boolean;
  onOpenWorkspace?: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openItems = file.items.filter((item) => !item.done);
  const doneItems = file.items.filter((item) => item.done);
  const totalCount = file.items.length;
  const progress = totalCount > 0 ? doneItems.length / totalCount : 0;
  const canSubmit = draft.trim() !== "" && !busy;

  const submit = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setDraft("");
    try {
      await actions.add(file.workspaceId, text);
      setError(null);
    } catch (cause) {
      setDraft(text);
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const runAction = (promise: Promise<unknown>) => {
    promise.then(() => setError(null)).catch((cause) => setError(messageOf(cause)));
  };

  const isGlobal = file.workspaceId === null;
  const displayPath = isGlobal ? "~/TODO.md" : file.path;

  return (
    <View style={styles.section}>
      {compactHeader ? (
        <View style={styles.compactHeader}>
          <View style={styles.compactMetaRow}>
            <Text style={[styles.compactStatus, { color: theme.colors.foreground }]}>
              {openItems.length === 0 && doneItems.length > 0
                ? "All done"
                : `${openItems.length} remaining`}
            </Text>
            {doneItems.length > 0 ? (
              <Text style={[styles.compactDoneCount, { color: theme.colors.foregroundMuted }]}>
                {doneItems.length}/{totalCount} completed
              </Text>
            ) : null}
          </View>
          <View style={[styles.progressTrack, { backgroundColor: theme.colors.surface2 }]}>
            <View
              style={[
                styles.progressFill,
                {
                  width: `${Math.round(progress * 100)}%`,
                  backgroundColor:
                    progress === 1 ? theme.colors.statusSuccess : theme.colors.accent,
                },
              ]}
            />
          </View>
        </View>
      ) : (
        <View style={styles.sectionHeader}>
          <View
            style={[
              styles.sectionIconWrap,
              {
                backgroundColor: isGlobal ? theme.colors.accent : theme.colors.surface2,
              },
            ]}
          >
            <Icon
              name={isGlobal ? "Inbox" : "FolderGit2"}
              size={14}
              color={isGlobal ? theme.colors.accentForeground : theme.colors.foreground}
            />
          </View>
          <View style={styles.sectionTitleBlock}>
            <View style={styles.sectionTitleRow}>
              <Text style={[styles.sectionTitle, { color: theme.colors.foreground }]} numberOfLines={1}>
                {isGlobal ? "Personal" : file.label}
              </Text>
              {file.project ? (
                <View style={[styles.projectTag, { backgroundColor: theme.colors.surface2 }]}>
                  <Text
                    style={[styles.projectTagText, { color: theme.colors.foregroundMuted }]}
                    numberOfLines={1}
                  >
                    {file.project}
                  </Text>
                </View>
              ) : null}
            </View>
            <Text
              style={[styles.sectionPath, { color: theme.colors.foregroundMuted }]}
              numberOfLines={1}
              ellipsizeMode="middle"
            >
              {displayPath}
            </Text>
          </View>
          <View style={styles.sectionRight}>
            {openItems.length > 0 ? (
              <View style={[styles.countBadge, { backgroundColor: theme.colors.surface2 }]}>
                <Text style={[styles.countBadgeText, { color: theme.colors.foreground }]}>
                  {openItems.length}
                </Text>
              </View>
            ) : doneItems.length > 0 ? (
              <Icon name="CheckCircle2" size={15} color={theme.colors.statusSuccess} />
            ) : null}
            {onOpenWorkspace ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Open workspace ${file.label}`}
                hitSlop={6}
                onPress={onOpenWorkspace}
                style={[styles.openWorkspaceButton, { borderColor: theme.colors.border }]}
              >
                <Icon name="ArrowUpRight" size={13} color={theme.colors.foregroundMuted} />
              </Pressable>
            ) : null}
          </View>
        </View>
      )}

      <View
        style={[
          styles.card,
          {
            backgroundColor: theme.colors.surface1,
            borderColor: focused ? theme.colors.accent : theme.colors.border,
          },
        ]}
      >
        <View
          style={[
            styles.composerRow,
            (openItems.length > 0 || doneItems.length > 0) && {
              borderBottomWidth: StyleSheet.hairlineWidth,
              borderBottomColor: theme.colors.border,
            },
          ]}
        >
          <View style={styles.plusSlot}>
            <Icon
              name="Plus"
              size={15}
              color={
                focused || draft.trim() !== ""
                  ? theme.colors.accent
                  : theme.colors.foregroundMuted
              }
            />
          </View>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onSubmitEditing={submit}
            blurOnSubmit={false}
            editable={!busy}
            returnKeyType="done"
            placeholder={isGlobal ? "New personal to-do…" : "New to-do…"}
            placeholderTextColor={theme.colors.foregroundMuted}
            accessibilityLabel={`Add a todo to ${file.label}`}
            style={[styles.composerInput, { color: theme.colors.foreground }]}
          />
          {canSubmit ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Add todo"
              onPress={submit}
              style={[styles.submitPill, { backgroundColor: theme.colors.accent }]}
            >
              <Icon name="CornerDownLeft" size={12} color={theme.colors.accentForeground} />
            </Pressable>
          ) : null}
        </View>

        {openItems.length === 0 && doneItems.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={[styles.emptyText, { color: theme.colors.foregroundMuted }]}>
              No tasks yet — type above to add one.
            </Text>
          </View>
        ) : (
          openItems.map((item, idx) => (
            <TodoRow
              key={item.index}
              item={item}
              last={idx === openItems.length - 1 && doneItems.length === 0}
              theme={theme}
              onToggle={() => runAction(actions.toggle(file.workspaceId, item.index))}
              onRemove={() => runAction(actions.remove(file.workspaceId, item.index))}
            />
          ))
        )}

        {doneItems.length > 0 ? (
          <View style={styles.completedContainer}>
            <View
              style={[
                styles.completedBar,
                { backgroundColor: theme.colors.surface0 },
                showDone && {
                  borderBottomWidth: StyleSheet.hairlineWidth,
                  borderBottomColor: theme.colors.border,
                },
              ]}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={showDone ? "Hide completed tasks" : "Show completed tasks"}
                onPress={() => setShowDone((prev) => !prev)}
                style={styles.completedToggle}
              >
                <Icon
                  name={showDone ? "ChevronDown" : "ChevronRight"}
                  size={13}
                  color={theme.colors.foregroundMuted}
                />
                <Text style={[styles.completedLabel, { color: theme.colors.foregroundMuted }]}>
                  Completed · {doneItems.length}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Clear completed tasks"
                hitSlop={6}
                onPress={() => runAction(actions.remove(file.workspaceId))}
              >
                <Text style={[styles.clearText, { color: theme.colors.foregroundMuted }]}>
                  Clear
                </Text>
              </Pressable>
            </View>
            {showDone
              ? doneItems.map((item, idx) => (
                  <TodoRow
                    key={item.index}
                    item={item}
                    last={idx === doneItems.length - 1}
                    theme={theme}
                    onToggle={() => runAction(actions.toggle(file.workspaceId, item.index))}
                    onRemove={() => runAction(actions.remove(file.workspaceId, item.index))}
                  />
                ))
              : null}
          </View>
        ) : null}
      </View>

      {error ? (
        <Text style={[styles.error, { color: theme.colors.statusDanger }]}>{error}</Text>
      ) : null}
    </View>
  );
}

export function TodoScreen({ theme, layout, navigation }: PluginScreenProps) {
  const todos = useTodos();
  const [filter, setFilter] = useState<FilterMode>("all");
  const data = todos.data;

  const workspaceFiles = data ? deduplicateFiles(data) : [];
  const allFiles = data ? [data.global, ...workspaceFiles] : [];
  const totalOpen = allFiles.reduce(
    (sum, file) => sum + file.items.filter((item) => !item.done).length,
    0,
  );
  const totalDone = allFiles.reduce(
    (sum, file) => sum + file.items.filter((item) => item.done).length,
    0,
  );
  const totalItems = totalOpen + totalDone;
  const totalProgress = totalItems > 0 ? totalDone / totalItems : 0;

  const filters: { id: FilterMode; label: string; count: number }[] = [
    { id: "all", label: "All", count: totalOpen },
    {
      id: "personal",
      label: "Personal",
      count: data ? data.global.items.filter((item) => !item.done).length : 0,
    },
    {
      id: "workspaces",
      label: "Workspaces",
      count: workspaceFiles.reduce(
        (sum, file) => sum + file.items.filter((item) => !item.done).length,
        0,
      ),
    },
  ];

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{
        padding: layout.compact ? 16 : 28,
        gap: 22,
        width: "100%",
        maxWidth: 720,
        alignSelf: "center",
      }}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.screenHeader}>
        <View style={styles.screenTopRow}>
          <View style={[styles.filterBar, { backgroundColor: theme.colors.surface1, borderColor: theme.colors.border }]}>
            {filters.map((tab) => {
              const active = filter === tab.id;
              return (
                <Pressable
                  key={tab.id}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: active }}
                  onPress={() => setFilter(tab.id)}
                  style={[
                    styles.filterTab,
                    active && { backgroundColor: theme.colors.surface2 },
                  ]}
                >
                  <Text
                    style={[
                      styles.filterTabText,
                      {
                        color: active ? theme.colors.foreground : theme.colors.foregroundMuted,
                        fontWeight: active ? "600" : "500",
                      },
                    ]}
                  >
                    {tab.label}
                  </Text>
                  {tab.count > 0 ? (
                    <Text
                      style={[
                        styles.filterTabCount,
                        { color: active ? theme.colors.accent : theme.colors.foregroundMuted },
                      ]}
                    >
                      {tab.count}
                    </Text>
                  ) : null}
                </Pressable>
              );
            })}
          </View>
          {data ? (
            <Text style={[styles.summaryText, { color: theme.colors.foregroundMuted }]}>
              {totalOpen} open · {totalDone} done
            </Text>
          ) : null}
        </View>
        {totalItems > 0 ? (
          <View style={[styles.progressTrack, { backgroundColor: theme.colors.surface2 }]}>
            <View
              style={[
                styles.progressFill,
                {
                  width: `${Math.round(totalProgress * 100)}%`,
                  backgroundColor:
                    totalProgress === 1 ? theme.colors.statusSuccess : theme.colors.accent,
                },
              ]}
            />
          </View>
        ) : null}
      </View>

      {todos.error ? (
        <Text style={{ color: theme.colors.statusDanger }}>{todos.error.message}</Text>
      ) : null}

      {data ? (
        <>
          {filter !== "workspaces" ? (
            <TodoSection file={data.global} theme={theme} actions={todos} />
          ) : null}
          {filter !== "personal"
            ? workspaceFiles.map((file) => (
                <TodoSection
                  key={file.workspaceId}
                  file={file}
                  theme={theme}
                  actions={todos}
                  onOpenWorkspace={
                    file.workspaceId && navigation?.openWorkspace
                      ? () => navigation.openWorkspace({ workspaceId: file.workspaceId! })
                      : undefined
                  }
                />
              ))
            : null}
          {filter === "workspaces" && workspaceFiles.length === 0 ? (
            <Text style={[styles.emptyText, { color: theme.colors.foregroundMuted }]}>
              No active workspace TODO lists.
            </Text>
          ) : null}
        </>
      ) : (
        <Text style={{ color: theme.colors.foregroundMuted }}>Loading…</Text>
      )}
    </ScrollView>
  );
}

export function WorkspaceTodosPanel({ theme, workspaceId }: PluginWorkspacePanelProps) {
  const todos = useTodos();
  const snapshot = useWorkspace(workspaceId, (workspace) => ({
    name: workspace.title ?? workspace.name,
    project: workspace.projectDisplayName,
    directory: workspace.directory,
  }));

  const matched = todos.data?.workspaces.find((item) => item.workspaceId === workspaceId);
  const file: TodoFile | null =
    matched ??
    (todos.data && snapshot
      ? {
          workspaceId,
          label: snapshot.name,
          project: snapshot.project,
          path: `${snapshot.directory}/TODO.md`,
          items: [],
        }
      : null);

  if (!file) {
    return (
      <View style={{ flex: 1, padding: 16, backgroundColor: theme.colors.surface0 }}>
        <Text style={{ color: theme.colors.foregroundMuted }}>
          {todos.error ? todos.error.message : "Loading…"}
        </Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding: 12, gap: 12 }}
      keyboardShouldPersistTaps="handled"
    >
      <TodoSection file={file} theme={theme} actions={todos} compactHeader />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  sidebarBadge: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 999,
    minWidth: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  sidebarBadgeText: {
    fontSize: 11,
    fontWeight: "600",
  },
  screenHeader: {
    gap: 10,
  },
  screenTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 10,
  },
  filterBar: {
    flexDirection: "row",
    alignItems: "center",
    padding: 3,
    borderRadius: 9,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 2,
  },
  filterTab: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
  },
  filterTabText: {
    fontSize: 12,
  },
  filterTabCount: {
    fontSize: 11,
    fontWeight: "600",
  },
  summaryText: {
    fontSize: 12,
    fontWeight: "500",
  },
  progressTrack: {
    height: 3,
    borderRadius: 999,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    borderRadius: 999,
  },
  section: {
    gap: 8,
  },
  compactHeader: {
    gap: 6,
    paddingHorizontal: 2,
  },
  compactMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  compactStatus: {
    fontSize: 12,
    fontWeight: "600",
  },
  compactDoneCount: {
    fontSize: 11,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 2,
  },
  sectionIconWrap: {
    width: 28,
    height: 28,
    borderRadius: 7,
    alignItems: "center",
    justifyContent: "center",
  },
  sectionTitleBlock: {
    flex: 1,
    gap: 1,
  },
  sectionTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: "600",
    flexShrink: 1,
  },
  projectTag: {
    paddingHorizontal: 6,
    paddingVertical: 1.5,
    borderRadius: 5,
    maxWidth: 140,
  },
  projectTagText: {
    fontSize: 10.5,
    fontWeight: "500",
  },
  sectionPath: {
    fontSize: 11,
  },
  sectionRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  countBadge: {
    minWidth: 22,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
  countBadgeText: {
    fontSize: 11,
    fontWeight: "600",
  },
  openWorkspaceButton: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  card: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  composerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  plusSlot: {
    width: 18,
    height: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  composerInput: {
    flex: 1,
    fontSize: 13.5,
    paddingVertical: 2,
  },
  submitPill: {
    width: 24,
    height: 22,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyState: {
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  emptyText: {
    fontSize: 12.5,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 9,
    gap: 8,
  },
  rowMain: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  checkbox: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  itemText: {
    flex: 1,
    fontSize: 13.5,
    lineHeight: 19,
  },
  deleteButton: {
    width: 22,
    height: 22,
    borderRadius: 5,
    alignItems: "center",
    justifyContent: "center",
    opacity: 0.7,
  },
  completedContainer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "transparent",
  },
  completedBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  completedToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  completedLabel: {
    fontSize: 11.5,
    fontWeight: "500",
  },
  clearText: {
    fontSize: 11.5,
    fontWeight: "500",
  },
  error: {
    fontSize: 12,
    paddingHorizontal: 4,
  },
});
