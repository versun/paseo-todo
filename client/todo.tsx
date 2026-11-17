import type {
  PluginButtonContentProps,
  PluginButtonRegistration,
  PluginClientContext,
  PluginScreenProps,
  PluginSidebarItemProps,
  PluginWorkspacePanelProps,
} from "@getpaseo/plugin/client";
import { useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { Icon, ScrollView, SidebarRow, TextInput } from "@getpaseo/plugin/client/ui";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  KeyboardAvoidingView,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import {
  addTodo,
  editTodo,
  listTodos,
  normalizeTaskText,
  removeTodo,
  toggleTodo,
  type TodoFile,
  type TodoItem,
  type TodoListData,
} from "../shared/todo";

const LIST_KEY = ["todo", "list"];
const MUTATION_KEY = ["todo", "mutation"];
const POLL_MS = 2000;
const GLOBAL_TARGET = { projectId: null, label: "Global" };

type TodoTheme = PluginScreenProps["theme"];
type TodoTarget = Pick<TodoFile, "projectId" | "label">;
type FilterMode = "all" | "global" | "projects";
type WorkspaceRef = { projectId: string; projectRootPath: string };

const dataListeners = new Set<(data: TodoListData) => void>();
let latestTodoData: TodoListData | undefined;
let lastFetchAt = 0;
let activeMutations = 0;
// Bumped when a mutation starts so a fetch that began earlier cannot publish
// pre-mutation data once the mutation settles.
let mutationEpoch = 0;
let recheckPills: (() => void) | null = null;

function publishTodoData(data: TodoListData) {
  latestTodoData = data;
  for (const listener of dataListeners) listener(data);
}

export function refreshTodoPills() {
  recheckPills?.();
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function openCount(files: TodoFile[]) {
  return files.reduce((sum, file) => sum + file.items.filter((item) => !item.done).length, 0);
}

/** Apply an optimistic edit to the target file, and to any project sharing its path. */
function updateFile(
  data: TodoListData | undefined,
  projectId: string | null,
  updater: (items: TodoItem[]) => TodoItem[],
): TodoListData | undefined {
  if (!data) return data;
  const path =
    projectId === null
      ? data.global.path
      : data.projects.find((file) => file.projectId === projectId)?.path;
  if (!path) return data;
  const apply = (file: TodoFile): TodoFile =>
    file.path === path
      ? { ...file, items: updater(file.items).map((item, index) => ({ ...item, index })) }
      : file;
  return { global: apply(data.global), projects: data.projects.map(apply) };
}

/** Polling pauses while a mutation is in flight so a poll cannot revert an optimistic edit. */
function useTodoList() {
  const list = useRpc(listTodos);
  const mutating = useIsMutating({ mutationKey: MUTATION_KEY }) > 0;
  return useQuery({
    queryKey: LIST_KEY,
    queryFn: async () => {
      lastFetchAt = Date.now();
      const epoch = mutationEpoch;
      const data = await list({});
      if (activeMutations === 0 && epoch === mutationEpoch) publishTodoData(data);
      return data;
    },
    initialData: () => latestTodoData,
    refetchInterval: mutating ? false : POLL_MS,
  });
}

function useTodoMutation<Input extends { projectId: string | null }>(
  mutationFn: (input: Input) => Promise<unknown>,
  optimistic: (items: TodoItem[], input: Input) => TodoItem[],
  setError: (error: string | null) => void,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: MUTATION_KEY,
    mutationFn,
    onMutate: async (input: Input) => {
      activeMutations += 1;
      mutationEpoch += 1;
      const cancel = queryClient.cancelQueries({ queryKey: LIST_KEY });
      queryClient.setQueryData<TodoListData>(LIST_KEY, (prev) => {
        const next = updateFile(prev, input.projectId, (items) => optimistic(items, input));
        if (next && next !== prev) publishTodoData(next);
        return next;
      });
      await cancel;
    },
    onSuccess: () => setError(null),
    onError: (cause) => setError(messageOf(cause)),
    // Refetch only after the last overlapping mutation; an earlier refetch would
    // flash back the optimistic edits still in flight. A failed edit is undone here.
    onSettled: () => {
      activeMutations = Math.max(0, activeMutations - 1);
      if (queryClient.isMutating({ mutationKey: MUTATION_KEY }) === 1) {
        const promise = queryClient.invalidateQueries({ queryKey: LIST_KEY });
        // Invalidation only refetches when a mounted surface observes the list
        // query; without one the pills would stay stale, so force the pill
        // poll. When a surface is open its refetch publishes fresh data, so
        // skip the duplicate RPC.
        const observed =
          (queryClient.getQueryCache().find({ queryKey: LIST_KEY })?.observers.length ?? 0) > 0;
        if (!observed) recheckPills?.();
        return promise;
      }
      return undefined;
    },
  });
}

function useTodos() {
  const query = useTodoList();
  const [actionError, setActionError] = useState<string | null>(null);
  const addRpc = useRpc(addTodo);
  const toggleRpc = useRpc(toggleTodo);
  const editRpc = useRpc(editTodo);
  const removeRpc = useRpc(removeTodo);

  const add = useTodoMutation(
    addRpc,
    (items, { text }) => [
      ...items,
      { index: items.length, text: normalizeTaskText(text), done: false },
    ],
    setActionError,
  );
  const toggle = useTodoMutation(
    toggleRpc,
    (items, { index }) =>
      items.map((item) => (item.index === index ? { ...item, done: !item.done } : item)),
    setActionError,
  );
  const edit = useTodoMutation(
    editRpc,
    (items, { index, newText }) =>
      items.map((item) =>
        item.index === index ? { ...item, text: normalizeTaskText(newText) } : item,
      ),
    setActionError,
  );
  const remove = useTodoMutation(
    removeRpc,
    (items, { index }) =>
      items.filter((item) => (index === undefined ? !item.done : item.index !== index)),
    setActionError,
  );

  return {
    data: query.data,
    error: actionError ?? (query.error ? messageOf(query.error) : null),
    add: (projectId: string | null, text: string) =>
      add.mutateAsync({ projectId, text: normalizeTaskText(text) }),
    toggle: (file: TodoFile, index: number, text: string) =>
      toggle.mutate({ projectId: file.projectId, index, text }),
    edit: (file: TodoFile, index: number, text: string, newText: string) =>
      edit.mutate({
        projectId: file.projectId,
        index,
        text,
        newText: normalizeTaskText(newText),
      }),
    remove: (file: TodoFile, index: number, text: string) =>
      remove.mutate({ projectId: file.projectId, index, text }),
    clearCompleted: (file: TodoFile) => remove.mutate({ projectId: file.projectId }),
  };
}

type TodoActions = ReturnType<typeof useTodos>;

export function TodoSidebarItem({ theme, currentScreen, openScreen }: PluginSidebarItemProps) {
  const { data } = useTodoList();
  const count = data ? openCount([data.global, ...data.projects]) : 0;

  return (
    <SidebarRow
      icon="ListTodo"
      active={currentScreen?.screenId === "todos"}
      onPress={() => openScreen({ screenId: "todos" })}
      trailing={
        count > 0 ? (
          <View style={[styles.badge, { backgroundColor: theme.colors.surface2 }]}>
            <Text style={[styles.badgeText, { color: theme.colors.foregroundMuted }]}>
              {count}
            </Text>
          </View>
        ) : undefined
      }
    />
  );
}

function ProgressBar({ theme, done, total }: { theme: TodoTheme; done: number; total: number }) {
  return (
    <View style={[styles.progressTrack, { backgroundColor: theme.colors.surface2 }]}>
      <View
        style={[
          styles.progressFill,
          {
            width: `${total > 0 ? Math.round((done / total) * 100) : 0}%`,
            backgroundColor:
              total > 0 && done === total ? theme.colors.statusSuccess : theme.colors.accent,
          },
        ]}
      />
    </View>
  );
}

function TodoRow({
  item,
  last,
  theme,
  onToggle,
  onEdit,
  onRemove,
}: {
  item: TodoItem;
  last: boolean;
  theme: TodoTheme;
  onToggle: (text: string) => void;
  onEdit: (text: string, newText: string) => void;
  onRemove: (text: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);
  // Tracks the authoritative text for this row, including an optimistic edit
  // committed earlier in the same gesture before React has re-rendered.
  const currentText = useRef(item.text);
  const prevPropText = useRef(item.text);
  const prevPropDone = useRef(item.done);
  // onSubmitEditing, onBlur, and row actions can overlap; commit at most once.
  const committed = useRef(false);

  if (item.text !== prevPropText.current || item.done !== prevPropDone.current) {
    const externalChange =
      item.text !== currentText.current || item.done !== prevPropDone.current;
    prevPropText.current = item.text;
    prevPropDone.current = item.done;
    currentText.current = item.text;
    if (editing && externalChange) {
      committed.current = true;
      setEditing(false);
      setDraft(item.text);
    }
  }

  // Never let an unmount blur (e.g. Clear or filter switch) fire a stale edit.
  useLayoutEffect(
    () => () => {
      committed.current = true;
    },
    [],
  );

  const commit = (): string => {
    if (committed.current) return currentText.current;
    committed.current = true;
    setEditing(false);
    const next = normalizeTaskText(draft);
    const prev = currentText.current;
    if (next && next !== prev) {
      currentText.current = next;
      onEdit(prev, next);
      return next;
    }
    return prev;
  };

  return (
    <View style={[styles.row, !last && styles.divider, { borderBottomColor: theme.colors.border }]}>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: item.done }}
        accessibilityLabel={`${item.done ? "Uncheck" : "Check off"} ${item.text}`}
        hitSlop={8}
        onPress={() => {
          const text = editing ? commit() : currentText.current;
          onToggle(text);
        }}
        style={styles.checkboxHit}
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
      </Pressable>
      {editing ? (
        <TextInput
          value={draft}
          onChangeText={setDraft}
          autoFocus
          onSubmitEditing={() => {
            commit();
          }}
          onBlur={() => {
            commit();
          }}
          onKeyPress={({ nativeEvent }) => {
            if (nativeEvent.key === "Escape") {
              committed.current = true;
              setDraft(currentText.current);
              setEditing(false);
            }
          }}
          returnKeyType="done"
          accessibilityLabel={`Edit ${item.text}`}
          style={[styles.itemText, styles.editInput, { color: theme.colors.foreground }]}
        />
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Edit ${item.text}`}
          onPress={() => {
            committed.current = false;
            setDraft(currentText.current);
            setEditing(true);
          }}
          style={styles.rowMain}
        >
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
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Delete ${item.text}`}
        hitSlop={8}
        onPress={() => {
          if (editing) {
            committed.current = true;
            setEditing(false);
          }
          onRemove(currentText.current);
        }}
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
  todos,
  compactHeader = false,
  onOpenWorkspace,
}: {
  file: TodoFile;
  theme: TodoTheme;
  todos: TodoActions;
  compactHeader?: boolean;
  onOpenWorkspace?: () => void;
}) {
  const [showDone, setShowDone] = useState(false);
  const openItems = file.items.filter((item) => !item.done);
  const doneItems = file.items.filter((item) => item.done);
  const total = file.items.length;
  const isGlobal = file.projectId === null;

  const renderRow = (item: TodoItem, last: boolean) => (
    <TodoRow
      key={item.index}
      item={item}
      last={last}
      theme={theme}
      onToggle={(text) => todos.toggle(file, item.index, text)}
      onEdit={(text, newText) => todos.edit(file, item.index, text, newText)}
      onRemove={(text) => todos.remove(file, item.index, text)}
    />
  );

  return (
    <View style={styles.section}>
      {compactHeader ? (
        <View style={styles.compactHeader}>
          <View style={styles.spacedRow}>
            <Text style={[styles.compactStatus, { color: theme.colors.foreground }]}>
              {openItems.length === 0 && total > 0 ? "All done" : `${openItems.length} remaining`}
            </Text>
            {doneItems.length > 0 ? (
              <Text style={[styles.compactDoneCount, { color: theme.colors.foregroundMuted }]}>
                {doneItems.length}/{total} completed
              </Text>
            ) : null}
          </View>
          <ProgressBar theme={theme} done={doneItems.length} total={total} />
        </View>
      ) : (
        <View style={styles.sectionHeader}>
          <View
            style={[
              styles.sectionIcon,
              { backgroundColor: isGlobal ? theme.colors.accent : theme.colors.surface2 },
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
              {file.label}
            </Text>
            <Text
              style={[styles.sectionPath, { color: theme.colors.foregroundMuted }]}
              numberOfLines={1}
              ellipsizeMode="middle"
            >
              {isGlobal ? "~/TODO.md" : file.path}
            </Text>
          </View>
          {openItems.length > 0 ? (
            <View style={[styles.badge, { backgroundColor: theme.colors.surface2 }]}>
              <Text style={[styles.badgeText, { color: theme.colors.foreground }]}>
                {openItems.length}
              </Text>
            </View>
          ) : (
            <Icon name="CheckCircle2" size={15} color={theme.colors.statusSuccess} />
          )}
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
      )}

      {total === 0 ? (
        <EmptyCard theme={theme} text="No tasks yet — add one below." />
      ) : (
        <View
          style={[
            styles.card,
            { backgroundColor: theme.colors.surface1, borderColor: theme.colors.border },
          ]}
        >
          {openItems.map((item, idx) =>
            renderRow(item, idx === openItems.length - 1 && doneItems.length === 0),
          )}
          {doneItems.length > 0 ? (
            <>
              <View
                style={[
                  styles.spacedRow,
                  styles.completedBar,
                  showDone && styles.divider,
                  {
                    backgroundColor: theme.colors.surface0,
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
                  <Text style={[styles.completedText, { color: theme.colors.foregroundMuted }]}>
                    Completed · {doneItems.length}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Clear completed tasks"
                  hitSlop={6}
                  onPress={() => todos.clearCompleted(file)}
                >
                  <Text style={[styles.completedText, { color: theme.colors.foregroundMuted }]}>
                    Clear
                  </Text>
                </Pressable>
              </View>
              {showDone
                ? doneItems.map((item, idx) => renderRow(item, idx === doneItems.length - 1))
                : null}
            </>
          ) : null}
        </View>
      )}
    </View>
  );
}

function EmptyCard({ theme, text }: { theme: TodoTheme; text: string }) {
  return (
    <View
      style={[
        styles.emptyCard,
        { backgroundColor: theme.colors.surface1, borderColor: theme.colors.border },
      ]}
    >
      <Text style={[styles.emptyText, { color: theme.colors.foregroundMuted }]}>{text}</Text>
    </View>
  );
}

/** The single add field. Shows the target picker only when `targets` is given. */
function TodoBottomComposer({
  theme,
  compact,
  target,
  targets,
  onSelectTarget,
  onAdd,
  error,
}: {
  theme: TodoTheme;
  compact: boolean;
  target: TodoTarget;
  targets?: TodoTarget[];
  onSelectTarget?: (projectId: string | null) => void;
  onAdd: (projectId: string | null, text: string) => Promise<unknown>;
  error: string | null;
}) {
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  const hasDraft = normalizeTaskText(draft) !== "";

  // Clear right away (the add is optimistic) and keep the input editable, so
  // focus stays for the next task. Restore the text if the add fails.
  const submit = () => {
    const text = normalizeTaskText(draft);
    if (!text) return;
    setDraft("");
    onAdd(target.projectId, text).catch(() => setDraft((current) => current || text));
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
        {targets && onSelectTarget ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.targetRow}
          >
            {targets.map((item) => {
              const selected = item.projectId === target.projectId;
              const foreground = selected ? theme.colors.accentForeground : theme.colors.foreground;
              return (
                <Pressable
                  key={item.projectId ?? "global"}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`Target ${item.label}`}
                  onPress={() => onSelectTarget(item.projectId)}
                  style={[
                    styles.targetChip,
                    {
                      backgroundColor: selected ? theme.colors.accent : theme.colors.surface1,
                      borderColor: selected ? theme.colors.accent : theme.colors.border,
                    },
                  ]}
                >
                  <Icon
                    name={item.projectId === null ? "Inbox" : "FolderGit2"}
                    size={12}
                    color={selected ? foreground : theme.colors.foregroundMuted}
                  />
                  <Text style={[styles.targetChipText, { color: foreground }]} numberOfLines={1}>
                    {item.label}
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
          <Icon
            name="Plus"
            size={15}
            color={focused || hasDraft ? theme.colors.accent : theme.colors.foregroundMuted}
          />
          <TextInput
            value={draft}
            onChangeText={setDraft}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onSubmitEditing={submit}
            blurOnSubmit={false}
            returnKeyType="done"
            placeholder={`Add to ${target.label}…`}
            placeholderTextColor={theme.colors.foregroundMuted}
            accessibilityLabel={`Add a todo to ${target.label}`}
            style={[styles.composerInput, { color: theme.colors.foreground }]}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Add todo"
            disabled={!hasDraft}
            onPress={submit}
            style={[
              styles.submitButton,
              { backgroundColor: hasDraft ? theme.colors.accent : theme.colors.surface2 },
            ]}
          >
            <Icon
              name="CornerDownLeft"
              size={12}
              color={hasDraft ? theme.colors.accentForeground : theme.colors.foregroundMuted}
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

/**
 * Shifts the bottom composer above the software keyboard on mobile.
 * `KeyboardAvoidingView` compares its local `layout.y` (0 inside Paseo's body
 * container) against `keyboardFrame.screenY`, so we measure the container's
 * window `y` offset (status bar + host header) and pass it as
 * `keyboardVerticalOffset`.
 */
function KeyboardAvoidingSurface({
  style,
  children,
}: {
  style: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const ref = useRef<View>(null);
  const [verticalOffset, setVerticalOffset] = useState(0);

  return (
    <View
      ref={ref}
      style={styles.fill}
      onLayout={() => {
        ref.current?.measureInWindow((_x, y) => {
          if (Number.isFinite(y)) setVerticalOffset(Math.round(y));
        });
      }}
    >
      <KeyboardAvoidingView
        style={style}
        behavior="padding"
        keyboardVerticalOffset={verticalOffset}
      >
        {children}
      </KeyboardAvoidingView>
    </View>
  );
}

export function TodoScreen({ theme, layout, navigation }: PluginScreenProps) {
  const todos = useTodos();
  const [filter, setFilter] = useState<FilterMode>("all");
  const [targetProjectId, setTargetProjectId] = useState<string | null>(null);
  const { data } = todos;

  const files = data ? [data.global, ...data.projects] : [];
  // Only groups with tasks are shown; the composer can still target any project.
  const visibleFiles = files.filter(
    (file) =>
      file.items.length > 0 &&
      (filter === "all" || (file.projectId === null) === (filter === "global")),
  );
  const totalOpen = openCount(files);
  const totalItems = files.reduce((sum, file) => sum + file.items.length, 0);
  const filters: { id: FilterMode; label: string; count: number }[] = [
    { id: "all", label: "All", count: totalOpen },
    { id: "global", label: "Global", count: data ? openCount([data.global]) : 0 },
    { id: "projects", label: "Projects", count: data ? openCount(data.projects) : 0 },
  ];
  // Falls back to Global when the chosen project disappears.
  const target = files.find((file) => file.projectId === targetProjectId) ?? GLOBAL_TARGET;

  return (
    <KeyboardAvoidingSurface style={[styles.fill, { backgroundColor: theme.colors.surface0 }]}>
      <ScrollView
        style={styles.fill}
        contentContainerStyle={[styles.screenContent, { padding: layout.compact ? 16 : 28 }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.screenHeader}>
          <View style={[styles.spacedRow, styles.screenTopRow]}>
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
                    style={[styles.filterTab, active && { backgroundColor: theme.colors.surface2 }]}
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
                {totalOpen} open · {totalItems - totalOpen} done
              </Text>
            ) : null}
          </View>
          {totalItems > 0 ? (
            <ProgressBar theme={theme} done={totalItems - totalOpen} total={totalItems} />
          ) : null}
        </View>

        {data ? (
          visibleFiles.length > 0 ? (
            visibleFiles.map((file) => {
              const workspaceId = file.workspaceId;
              return (
                <TodoSection
                  key={file.projectId ?? "global"}
                  file={file}
                  theme={theme}
                  todos={todos}
                  onOpenWorkspace={
                    workspaceId && navigation
                      ? () => navigation.openWorkspace({ workspaceId })
                      : undefined
                  }
                />
              );
            })
          ) : (
            <EmptyCard theme={theme} text="No tasks here — pick a target below to add one." />
          )
        ) : todos.error ? null : (
          <Text style={{ color: theme.colors.foregroundMuted }}>Loading…</Text>
        )}
      </ScrollView>

      <TodoBottomComposer
        theme={theme}
        compact={layout.compact}
        target={target}
        targets={data ? files : [GLOBAL_TARGET]}
        onSelectTarget={setTargetProjectId}
        onAdd={todos.add}
        error={todos.error}
      />
    </KeyboardAvoidingSurface>
  );
}

/** The Explorer list: the workspace's project, or the global list for a workspace rooted at `~`. */
function workspaceFile(data: TodoListData, projectId: string, rootPath: string): TodoFile | null {
  const project = data.projects.find((file) => file.projectId === projectId);
  if (project) return project;
  const homeDir = data.global.path.replace(/[\\/]TODO\.md$/, "");
  return rootPath.replace(/[\\/]+$/, "") === homeDir ? data.global : null;
}

function resolveWorkspaceFile(
  data: TodoListData | undefined,
  workspaceId: string,
  workspace?: WorkspaceRef | null,
): TodoFile | null {
  if (!data) return null;
  if (workspace) {
    return workspaceFile(data, workspace.projectId, workspace.projectRootPath);
  }
  return data.projects.find((file) => file.workspaceId === workspaceId) ?? null;
}

function WorkspaceTodoPillPopover({
  theme,
  workspaceId,
  close,
  onOpenPanel,
}: PluginButtonContentProps & {
  onOpenPanel: (workspaceId: string) => void;
}) {
  const todos = useTodos();
  const workspace = useWorkspace(workspaceId, (snapshot) => ({
    projectId: snapshot.projectId,
    projectRootPath: snapshot.projectRootPath,
  }));
  const file = resolveWorkspaceFile(todos.data, workspaceId, workspace);
  const openItems = file ? file.items.filter((item) => !item.done) : [];

  return (
    <View style={styles.popover}>
      {file && openItems.length > 0 ? (
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
              last={idx === openItems.length - 1}
              theme={theme}
              onToggle={(text) => todos.toggle(file, item.index, text)}
              onEdit={(text, newText) => todos.edit(file, item.index, text, newText)}
              onRemove={(text) => todos.remove(file, item.index, text)}
            />
          ))}
        </View>
      ) : null}

      {todos.error ? (
        <Text style={[styles.error, { color: theme.colors.statusDanger }]}>{todos.error}</Text>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open TODO tab"
        onPress={() => {
          close();
          onOpenPanel(workspaceId);
        }}
        style={({ pressed }) => [
          styles.popoverSidebarButton,
          {
            backgroundColor: pressed ? theme.colors.surface2 : theme.colors.surface1,
            borderColor: theme.colors.border,
          },
        ]}
      >
        <Icon name="PanelRight" size={14} color={theme.colors.foregroundMuted} />
        <Text style={[styles.popoverSidebarButtonText, { color: theme.colors.foreground }]}>
          Open TODO tab
        </Text>
      </Pressable>
    </View>
  );
}

export function contributeComposerPills(client: PluginClientContext) {
  const workspaces = new Map<string, WorkspaceRef>();
  const agents = new Map<string, { id: string; workspaceId: string }>();
  const pills = new Map<
    string,
    { workspaceId: string; visible: boolean; label: string; reg: PluginButtonRegistration }
  >();
  const lifetime = new AbortController();
  let stopped = false;
  let polling = false;
  let queuedForce = false;

  const PopoverContent = (props: PluginButtonContentProps) => (
    <WorkspaceTodoPillPopover
      {...props}
      onOpenPanel={(workspaceId) =>
        client.openPanel("todos", { workspaceId, location: "explorer" })
      }
    />
  );

  const forgetAgent = (agentId: string) => {
    pills.get(agentId)?.reg.remove();
    pills.delete(agentId);
    agents.delete(agentId);
  };

  const syncAgent = (agent: { id: string; workspaceId: string }) => {
    if (stopped) return;
    const file = resolveWorkspaceFile(
      latestTodoData,
      agent.workspaceId,
      workspaces.get(agent.workspaceId),
    );
    const count = file ? openCount([file]) : 0;
    const visible = count > 0;
    const label = count > 0 ? `TODO · ${count}` : "TODO";
    const existing = pills.get(agent.id);
    if (existing && existing.workspaceId === agent.workspaceId) {
      if (existing.visible !== visible || existing.label !== label) {
        existing.visible = visible;
        existing.label = label;
        existing.reg.update({ visible, label });
      }
      return;
    }
    existing?.reg.remove();
    const reg = client.addComposerPill({
      id: "todos",
      workspaceId: agent.workspaceId,
      agentId: agent.id,
      button: {
        title: "TODO",
        icon: "ListTodo",
        label,
        visible,
        behavior: {
          kind: "popover",
          Content: PopoverContent,
        },
      },
    });
    pills.set(agent.id, { workspaceId: agent.workspaceId, visible, label, reg });
  };

  const syncAll = () => {
    if (stopped) return;
    for (const agent of agents.values()) syncAgent(agent);
  };

  const applyAgent = (agent: {
    id: string;
    workspaceId?: string | null;
    archivedAt?: string | null;
    internal?: boolean;
  }) => {
    if (stopped) return;
    if (!agent.workspaceId || agent.archivedAt || agent.internal) {
      forgetAgent(agent.id);
      return;
    }
    const next = { id: agent.id, workspaceId: agent.workspaceId };
    agents.set(agent.id, next);
    syncAgent(next);
  };

  const onData = () => syncAll();
  dataListeners.add(onData);

  const poll = async (force = false) => {
    if (stopped) return;
    if (polling || activeMutations > 0) {
      // Keep the forced recheck pending instead of dropping it (e.g. a `/todo`
      // add that lands mid-poll or mid-mutation).
      if (force) queuedForce = true;
      return;
    }
    if (!force && Date.now() - lastFetchAt < POLL_MS - 200) return;
    polling = true;
    lastFetchAt = Date.now();
    const epoch = mutationEpoch;
    try {
      const data = await client.rpc(listTodos, {});
      if (!stopped && activeMutations === 0 && epoch === mutationEpoch) publishTodoData(data);
    } catch {
      // Transient RPC or reconnect errors recover on the next poll.
    } finally {
      polling = false;
      if (queuedForce) {
        queuedForce = false;
        void poll(true);
      }
    }
  };

  const recheck = () => void poll(true);
  recheckPills = recheck;
  void poll(true);
  const timer = setInterval(() => void poll(false), POLL_MS);

  let workspaceSub: { release(): Promise<void> } | null = null;
  let workspaceRetry: ReturnType<typeof setTimeout> | null = null;
  let includeBackground = true;

  const observeWorkspaces = () => {
    void client.paseo.workspaces
      .list({ includeBackground, subscribe: {} })
      .then(({ subscription }) => {
        if (stopped) {
          void subscription.release();
          return;
        }
        workspaceSub = subscription;
        subscription.subscribe({
          snapshot: ({ entries }) => {
            workspaces.clear();
            for (const ws of entries) {
              if (!ws.archivingAt) {
                workspaces.set(ws.id, {
                  projectId: ws.projectId,
                  projectRootPath: ws.projectRootPath,
                });
              }
            }
            syncAll();
          },
          update: (message) => {
            if (message.type !== "workspace_update") return;
            const update = message.payload;
            if (update.kind === "remove") {
              workspaces.delete(update.id);
            } else if (update.workspace.archivingAt) {
              workspaces.delete(update.workspace.id);
            } else {
              workspaces.set(update.workspace.id, {
                projectId: update.workspace.projectId,
                projectRootPath: update.workspace.projectRootPath,
              });
            }
            syncAll();
          },
        });
      })
      .catch((error: unknown) => {
        if (stopped) return;
        if (includeBackground) {
          // Older daemons reject `includeBackground`; retry without it.
          includeBackground = false;
          observeWorkspaces();
          return;
        }
        console.error("[todo] workspace observation failed", error);
        // Transient failure (e.g. reconnecting): keep retrying so pills are
        // not permanently degraded to the `file.workspaceId` fallback.
        workspaceRetry = setTimeout(observeWorkspaces, POLL_MS * 5);
      });
  };
  observeWorkspaces();

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      if (stopped) return;
      subscription.subscribe({
        snapshot: ({ entries }) => {
          const seen = new Set<string>();
          for (const { agent } of entries) {
            seen.add(agent.id);
            applyAgent(agent);
          }
          for (const agentId of [...agents.keys()]) {
            if (!seen.has(agentId)) forgetAgent(agentId);
          }
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "remove") forgetAgent(update.agentId);
          else applyAgent(update.agent);
        },
      });
    })
    .catch((error: unknown) => {
      if (!lifetime.signal.aborted) console.error("[todo] agent observation failed", error);
    });

  return () => {
    stopped = true;
    if (recheckPills === recheck) recheckPills = null;
    clearInterval(timer);
    if (workspaceRetry) clearTimeout(workspaceRetry);
    dataListeners.delete(onData);
    lifetime.abort();
    void workspaceSub?.release();
    for (const pill of pills.values()) pill.reg.remove();
    pills.clear();
    agents.clear();
    workspaces.clear();
  };
}

export function WorkspaceTodosPanel({ theme, workspaceId }: PluginWorkspacePanelProps) {
  const todos = useTodos();
  const workspace = useWorkspace(workspaceId, (snapshot) => ({
    projectId: snapshot.projectId,
    projectRootPath: snapshot.projectRootPath,
  }));
  const file =
    todos.data && workspace
      ? workspaceFile(todos.data, workspace.projectId, workspace.projectRootPath)
      : null;

  if (!file) {
    return (
      <View style={[styles.fill, styles.panelMessage, { backgroundColor: theme.colors.surface0 }]}>
        <Text style={{ color: todos.error ? theme.colors.statusDanger : theme.colors.foregroundMuted }}>
          {todos.error ?? (todos.data ? "This workspace has no project TODO list." : "Loading…")}
        </Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingSurface style={[styles.fill, { backgroundColor: theme.colors.surface0 }]}>
      <ScrollView
        style={styles.fill}
        contentContainerStyle={styles.panelContent}
        keyboardShouldPersistTaps="handled"
      >
        <TodoSection key={file.path} file={file} theme={theme} todos={todos} compactHeader />
      </ScrollView>
      <TodoBottomComposer
        theme={theme}
        compact
        target={file}
        onAdd={todos.add}
        error={todos.error}
      />
    </KeyboardAvoidingSurface>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
  spacedRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  divider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  badge: {
    minWidth: 20,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: {
    fontSize: 11,
    fontWeight: "600",
  },
  screenContent: {
    gap: 22,
    width: "100%",
    maxWidth: 720,
    alignSelf: "center",
  },
  screenHeader: {
    gap: 10,
  },
  screenTopRow: {
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
  panelContent: {
    padding: 12,
  },
  panelMessage: {
    padding: 16,
  },
  section: {
    gap: 8,
  },
  compactHeader: {
    gap: 6,
    paddingHorizontal: 2,
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
  sectionIcon: {
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
  },
  sectionPath: {
    fontSize: 11,
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
    gap: 10,
  },
  rowMain: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
  },
  checkboxHit: {
    alignItems: "center",
    justifyContent: "center",
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
  editInput: {
    padding: 0,
    paddingVertical: 0,
    margin: 0,
  },
  deleteButton: {
    width: 22,
    height: 22,
    alignItems: "center",
    justifyContent: "center",
    opacity: 0.7,
  },
  completedBar: {
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  completedToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  completedText: {
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
  targetRow: {
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
  composerInput: {
    flex: 1,
    fontSize: 13.5,
    paddingVertical: 2,
  },
  submitButton: {
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
  popover: {
    gap: 8,
  },
  popoverSidebarButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
  },
  popoverSidebarButtonText: {
    fontSize: 12.5,
    fontWeight: "500",
  },
});
