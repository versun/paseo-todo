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
type FilterMode = "all" | "global" | "projects";

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function reindex(items: TodoItem[]): TodoItem[] {
  return items.map((item, idx) => ({ ...item, index: idx }));
}

function updateMatchingFiles(
  data: TodoListData | undefined,
  projectId: string | null,
  updater: (items: TodoItem[]) => TodoItem[],
): TodoListData | undefined {
  if (!data) return data;
  const targetPath =
    projectId === null
      ? data.global.path
      : data.projects.find((item) => item.projectId === projectId)?.path;
  if (!targetPath) return data;
  const apply = (file: TodoFile): TodoFile =>
    file.path === targetPath ? { ...file, items: reindex(updater(file.items)) } : file;
  return {
    global: apply(data.global),
    projects: data.projects.map(apply),
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
    onMutate: async ({ projectId, text }) => {
      await queryClient.cancelQueries({ queryKey: QUERY_KEY });
      queryClient.setQueryData<TodoListData>(QUERY_KEY, (prev) =>
        updateMatchingFiles(prev, projectId, (items) => [
          ...items,
          { index: items.length, text, done: false },
        ]),
      );
    },
    onSettled: invalidate,
  });

  const toggleMutation = useMutation({
    mutationFn: toggleRpc,
    onMutate: async ({ projectId, index }) => {
      await queryClient.cancelQueries({ queryKey: QUERY_KEY });
      queryClient.setQueryData<TodoListData>(QUERY_KEY, (prev) =>
        updateMatchingFiles(prev, projectId, (items) =>
          items.map((item) => (item.index === index ? { ...item, done: !item.done } : item)),
        ),
      );
    },
    onSettled: invalidate,
  });

  const removeMutation = useMutation({
    mutationFn: removeRpc,
    onMutate: async ({ projectId, index }) => {
      await queryClient.cancelQueries({ queryKey: QUERY_KEY });
      queryClient.setQueryData<TodoListData>(QUERY_KEY, (prev) =>
        updateMatchingFiles(prev, projectId, (items) =>
          items.filter((item) => (index !== undefined ? item.index !== index : !item.done)),
        ),
      );
    },
    onSettled: invalidate,
  });

  return {
    data: query.data,
    error: query.error,
    add: (projectId: string | null, text: string) =>
      addMutation.mutateAsync({ projectId, text }),
    toggle: (projectId: string | null, index: number) =>
      toggleMutation.mutateAsync({ projectId, index }),
    remove: (projectId: string | null, index?: number) =>
      removeMutation.mutateAsync({ projectId, index }),
  };
}

type TodoActions = Pick<ReturnType<typeof useTodos>, "add" | "toggle" | "remove">;

export function TodoSidebarItem({ theme, currentScreen, openScreen }: PluginSidebarItemProps) {
  const { data } = useTodos();
  const openCount = data
    ? [data.global, ...data.projects].reduce(
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
  const [showDone, setShowDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openItems = file.items.filter((item) => !item.done);
  const doneItems = file.items.filter((item) => item.done);
  const totalCount = file.items.length;
  const progress = totalCount > 0 ? doneItems.length / totalCount : 0;

  const runAction = (promise: Promise<unknown>) => {
    promise.then(() => setError(null)).catch((cause) => setError(messageOf(cause)));
  };

  const isGlobal = file.projectId === null;
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
            <Text style={[styles.sectionTitle, { color: theme.colors.foreground }]} numberOfLines={1}>
              {isGlobal ? "Global" : file.label}
            </Text>
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
                accessibilityLabel={`Open ${file.label}`}
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

      {totalCount === 0 ? (
        <View
          style={[
            styles.emptyCard,
            { backgroundColor: theme.colors.surface1, borderColor: theme.colors.border },
          ]}
        >
          <Text style={[styles.emptyText, { color: theme.colors.foregroundMuted }]}>
            No tasks yet — add one below.
          </Text>
        </View>
      ) : (
        <View
          style={[
            styles.card,
            { backgroundColor: theme.colors.surface1, borderColor: theme.colors.border },
          ]}
        >
          {openItems.map((item, idx) => (
            <TodoRow
              key={item.index}
              item={item}
              last={idx === openItems.length - 1 && doneItems.length === 0}
              theme={theme}
              onToggle={() => runAction(actions.toggle(file.projectId, item.index))}
              onRemove={() => runAction(actions.remove(file.projectId, item.index))}
            />
          ))}

          {doneItems.length > 0 ? (
            <View>
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
                  onPress={() => runAction(actions.remove(file.projectId))}
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
                      onToggle={() => runAction(actions.toggle(file.projectId, item.index))}
                      onRemove={() => runAction(actions.remove(file.projectId, item.index))}
                    />
                  ))
                : null}
            </View>
          ) : null}
        </View>
      )}

      {error ? (
        <Text style={[styles.error, { color: theme.colors.statusDanger }]}>{error}</Text>
      ) : null}
    </View>
  );
}

interface ComposerTarget {
  projectId: string | null;
  label: string;
}

function TodoBottomComposer({
  theme,
  compact,
  projectId,
  targetLabel,
  targets,
  onSelectProject,
  onAdd,
}: {
  theme: TodoTheme;
  compact?: boolean;
  projectId: string | null;
  targetLabel: string;
  targets?: ComposerTarget[];
  onSelectProject?: (projectId: string | null) => void;
  onAdd: (projectId: string | null, text: string) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = draft.trim() !== "" && !busy;

  const submit = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setDraft("");
    try {
      await onAdd(projectId, text);
      setError(null);
    } catch (cause) {
      setDraft(text);
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View
      style={[
        styles.bottomDock,
        {
          backgroundColor: theme.colors.surface0,
          borderTopColor: theme.colors.border,
          paddingHorizontal: compact ? 12 : 24,
          paddingVertical: compact ? 10 : 14,
        },
      ]}
    >
      <View style={styles.bottomDockInner}>
        {targets && onSelectProject ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.targetSelectorRow}
          >
            {targets.map((target) => {
              const selected = target.projectId === projectId;
              const isGlobal = target.projectId === null;
              return (
                <Pressable
                  key={target.projectId ?? "__global__"}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`Target ${target.label}`}
                  onPress={() => onSelectProject(target.projectId)}
                  style={[
                    styles.targetChip,
                    {
                      backgroundColor: selected
                        ? theme.colors.accent
                        : theme.colors.surface1,
                      borderColor: selected ? theme.colors.accent : theme.colors.border,
                    },
                  ]}
                >
                  <Icon
                    name={isGlobal ? "Inbox" : "FolderGit2"}
                    size={12}
                    color={
                      selected ? theme.colors.accentForeground : theme.colors.foregroundMuted
                    }
                  />
                  <Text
                    style={[
                      styles.targetChipText,
                      {
                        color: selected
                          ? theme.colors.accentForeground
                          : theme.colors.foreground,
                      },
                    ]}
                    numberOfLines={1}
                  >
                    {target.label}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        ) : null}

        <View
          style={[
            styles.composerBox,
            {
              backgroundColor: theme.colors.surface1,
              borderColor: focused ? theme.colors.accent : theme.colors.border,
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
            placeholder={`Add to ${targetLabel}…`}
            placeholderTextColor={theme.colors.foregroundMuted}
            accessibilityLabel={`Add a todo to ${targetLabel}`}
            style={[styles.composerInput, { color: theme.colors.foreground }]}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Add todo"
            disabled={!canSubmit}
            onPress={submit}
            style={[
              styles.submitPill,
              {
                backgroundColor: canSubmit ? theme.colors.accent : theme.colors.surface2,
              },
            ]}
          >
            <Icon
              name="CornerDownLeft"
              size={12}
              color={canSubmit ? theme.colors.accentForeground : theme.colors.foregroundMuted}
            />
          </Pressable>
        </View>

        {error ? (
          <Text style={[styles.error, { color: theme.colors.statusDanger }]}>{error}</Text>
        ) : null}
      </View>
    </View>
  );
}

export function TodoScreen({ theme, layout, navigation }: PluginScreenProps) {
  const todos = useTodos();
  const [filter, setFilter] = useState<FilterMode>("all");
  const [targetProjectId, setTargetProjectId] = useState<string | null>(null);
  const data = todos.data;

  const allProjects = data ? data.projects : [];
  const projectsWithTodos = allProjects.filter((file) => file.items.length > 0);
  const showGlobalSection = Boolean(
    data && filter !== "projects" && data.global.items.length > 0,
  );
  const visibleProjects = filter === "global" ? [] : projectsWithTodos;

  const countedFiles = data ? [data.global, ...projectsWithTodos] : [];
  const totalOpen = countedFiles.reduce(
    (sum, file) => sum + file.items.filter((item) => !item.done).length,
    0,
  );
  const totalDone = countedFiles.reduce(
    (sum, file) => sum + file.items.filter((item) => item.done).length,
    0,
  );
  const totalItems = totalOpen + totalDone;
  const totalProgress = totalItems > 0 ? totalDone / totalItems : 0;

  const filters: { id: FilterMode; label: string; count: number }[] = [
    { id: "all", label: "All", count: totalOpen },
    {
      id: "global",
      label: "Global",
      count: data ? data.global.items.filter((item) => !item.done).length : 0,
    },
    {
      id: "projects",
      label: "Projects",
      count: projectsWithTodos.reduce(
        (sum, file) => sum + file.items.filter((item) => !item.done).length,
        0,
      ),
    },
  ];

  const composerTargets: ComposerTarget[] = [
    { projectId: null, label: "Global" },
    ...allProjects.map((file) => ({
      projectId: file.projectId,
      label: file.label,
    })),
  ];

  const effectiveProjectId = composerTargets.some(
    (item) => item.projectId === targetProjectId,
  )
    ? targetProjectId
    : null;
  const activeTargetLabel =
    composerTargets.find((item) => item.projectId === effectiveProjectId)?.label ?? "Global";

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <ScrollView
        style={{ flex: 1 }}
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
            <View
              style={[
                styles.filterBar,
                { backgroundColor: theme.colors.surface1, borderColor: theme.colors.border },
              ]}
            >
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
            {showGlobalSection ? (
              <TodoSection file={data.global} theme={theme} actions={todos} />
            ) : null}
            {visibleProjects.map((file) => (
              <TodoSection
                key={file.projectId}
                file={file}
                theme={theme}
                actions={todos}
                onOpenWorkspace={
                  file.workspaceId && navigation?.openWorkspace
                    ? () => navigation.openWorkspace({ workspaceId: file.workspaceId! })
                    : undefined
                }
              />
            ))}
            {!showGlobalSection && visibleProjects.length === 0 ? (
              <View
                style={[
                  styles.emptyCard,
                  { backgroundColor: theme.colors.surface1, borderColor: theme.colors.border },
                ]}
              >
                <Text style={[styles.emptyText, { color: theme.colors.foregroundMuted }]}>
                  No todos yet — choose a project below to add one.
                </Text>
              </View>
            ) : null}
          </>
        ) : (
          <Text style={{ color: theme.colors.foregroundMuted }}>Loading…</Text>
        )}
      </ScrollView>

      <TodoBottomComposer
        theme={theme}
        compact={layout.compact}
        projectId={effectiveProjectId}
        targetLabel={activeTargetLabel}
        targets={composerTargets}
        onSelectProject={setTargetProjectId}
        onAdd={todos.add}
      />
    </View>
  );
}

export function WorkspaceTodosPanel({ theme, workspaceId }: PluginWorkspacePanelProps) {
  const todos = useTodos();
  const snapshot = useWorkspace(workspaceId, (workspace) => ({
    projectId: workspace.projectId,
    projectName: workspace.projectDisplayName,
    projectRootPath: workspace.projectRootPath,
  }));

  const data = todos.data;
  const matchedProject = data?.projects.find((item) => item.projectId === snapshot?.projectId);
  const isGlobalRoot =
    Boolean(snapshot && data && `${snapshot.projectRootPath}/TODO.md` === data.global.path);

  const file: TodoFile | null =
    matchedProject ??
    (isGlobalRoot && data
      ? data.global
      : data && snapshot
        ? {
            projectId: snapshot.projectId,
            workspaceId,
            label: snapshot.projectName,
            path: `${snapshot.projectRootPath}/TODO.md`,
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
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 12, gap: 12 }}
        keyboardShouldPersistTaps="handled"
      >
        <TodoSection file={file} theme={theme} actions={todos} compactHeader />
      </ScrollView>
      <TodoBottomComposer
        theme={theme}
        compact
        projectId={file.projectId}
        targetLabel={file.label}
        onAdd={todos.add}
      />
    </View>
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
  sectionTitle: {
    fontSize: 14,
    fontWeight: "600",
    flexShrink: 1,
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
  emptyCard: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 16,
    alignItems: "center",
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
  bottomDock: {
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  bottomDockInner: {
    width: "100%",
    maxWidth: 720,
    alignSelf: "center",
    gap: 8,
  },
  targetSelectorRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  targetChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    maxWidth: 200,
  },
  targetChipText: {
    fontSize: 12,
    fontWeight: "500",
    flexShrink: 1,
  },
  composerBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
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
    width: 28,
    height: 26,
    borderRadius: 7,
    alignItems: "center",
    justifyContent: "center",
  },
  error: {
    fontSize: 12,
    paddingHorizontal: 4,
  },
});
