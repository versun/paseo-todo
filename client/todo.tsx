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
import {
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Animated,
  Easing,
  KeyboardAvoidingView,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextInput as NativeTextInput,
  type ViewStyle,
} from "react-native";
import {
  addTodo,
  editTodo,
  listTodos,
  messageOf,
  moveTodo,
  normalizeNoteText,
  normalizeTaskText,
  noteTodo,
  removeTodo,
  toggleTodo,
  visibleTodoFiles,
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
  for (const listener of dataListeners) {
    try {
      listener(data);
    } catch (error) {
      // A failing listener (e.g. pill registration) must not fail the fetch or
      // starve the listeners after it.
      console.error("[todo] data listener failed", error);
    }
  }
}

export function refreshTodoPills() {
  recheckPills?.();
}

function openCount(files: TodoFile[]) {
  return files.reduce((sum, file) => sum + file.items.filter((item) => !item.done).length, 0);
}

/** The file a projectId writes to: the global file for `null` and `~` roots. */
function pathFor(data: TodoListData, projectId: string | null): string | undefined {
  return projectId === null
    ? data.global.path
    : (data.projects.find((file) => file.projectId === projectId)?.path ??
        // Projects rooted at `~` (even via symlink) are not listed; their file
        // is the global one.
        (data.homeProjectIds.includes(projectId) ? data.global.path : undefined));
}

/** Returns `data` itself when no file changed, so no-ops keep query identity. */
function mapFiles(
  data: TodoListData,
  apply: (file: TodoFile) => TodoFile,
): TodoListData {
  const global = apply(data.global);
  const projects = data.projects.map(apply);
  if (global === data.global && projects.every((file, i) => file === data.projects[i])) {
    return data;
  }
  return { ...data, global, projects };
}

/** Apply an optimistic edit to the target file, and to any project sharing its path. */
function updateFile(
  data: TodoListData | undefined,
  projectId: string | null,
  updater: (items: TodoItem[]) => TodoItem[],
): TodoListData | undefined {
  if (!data) return data;
  const path = pathFor(data, projectId);
  if (!path) return data;
  return mapFiles(data, (file) => {
    if (file.path !== path) return file;
    const items = updater(file.items);
    if (items === file.items) return file;
    return { ...file, items: items.map((item, index) => ({ ...item, index })) };
  });
}

/**
 * Optimistic counterpart of `todo.move`: relocate the item between two files
 * (or reorder inside one), mirroring the server's index adjustment and
 * clamping. No-ops and missing items leave the data untouched.
 */
function moveInData(
  data: TodoListData | undefined,
  input: { projectId: string | null; index: number; toProjectId: string | null; toIndex: number },
): TodoListData | undefined {
  if (!data) return data;
  const fromPath = pathFor(data, input.projectId);
  const toPath = pathFor(data, input.toProjectId);
  if (!fromPath || !toPath) return data;
  if (fromPath === toPath) {
    return updateFile(data, input.projectId, (items) => {
      const item = items.find((entry) => entry.index === input.index);
      if (!item) return items;
      const at = input.toIndex > input.index ? input.toIndex - 1 : input.toIndex;
      if (at === input.index) return items;
      const rest = items.filter((entry) => entry.index !== input.index);
      rest.splice(Math.min(Math.max(at, 0), rest.length), 0, item);
      return rest;
    });
  }
  const source = [data.global, ...data.projects].find((file) => file.path === fromPath);
  const moved = source?.items.find((item) => item.index === input.index);
  if (!moved) return data;
  return mapFiles(data, (file) => {
    if (file.path === fromPath) {
      return {
        ...file,
        items: file.items
          .filter((item) => item.index !== input.index)
          .map((item, index) => ({ ...item, index })),
      };
    }
    if (file.path === toPath) {
      const items = [...file.items];
      items.splice(Math.min(Math.max(input.toIndex, 0), items.length), 0, moved);
      return { ...file, items: items.map((item, index) => ({ ...item, index })) };
    }
    return file;
  });
}

/**
 * The QueryClient of any mounted surface, captured so the pill-side poll can
 * write fresh data into the shared cache (otherwise an open surface would
 * show stale rows until its own tick after e.g. a `/todo` add).
 */
let todoQueryClient: QueryClient | null = null;

/** Mirror the latest render value into a ref, for callbacks fired later. */
function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/** Polling pauses while a mutation is in flight so a poll cannot revert an optimistic edit. */
function useTodoList() {
  const list = useRpc(listTodos);
  const queryClient = useQueryClient();
  todoQueryClient = queryClient;
  const mutating = useIsMutating({ mutationKey: MUTATION_KEY }) > 0;
  return useQuery({
    queryKey: LIST_KEY,
    queryFn: async () => {
      lastFetchAt = Date.now();
      const epoch = mutationEpoch;
      const data = await list({});
      if (activeMutations === 0 && epoch === mutationEpoch) {
        publishTodoData(data);
        return data;
      }
      // A mutation began after this fetch started: its optimistic state is
      // newer than this response, so keep it and let the settle-invalidation
      // refetch the truth.
      return latestTodoData ?? data;
    },
    initialData: () => latestTodoData,
    refetchInterval: mutating ? false : POLL_MS,
  });
}

function useTodoMutation<Input>(
  mutationFn: (input: Input) => Promise<unknown>,
  optimistic: (data: TodoListData | undefined, input: Input) => TodoListData | undefined,
  setError: (error: string | null) => void,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: MUTATION_KEY,
    mutationFn,
    onMutate: async (input: Input) => {
      activeMutations += 1;
      mutationEpoch += 1;
      await queryClient.cancelQueries({ queryKey: LIST_KEY });
      queryClient.setQueryData<TodoListData>(LIST_KEY, (prev) => {
        const next = optimistic(prev, input);
        if (next && next !== prev) publishTodoData(next);
        return next;
      });
    },
    onSuccess: () => setError(null),
    onError: (cause) => setError(messageOf(cause)),
    // Refetch only after the last overlapping mutation (this one still counts
    // as pending inside onSettled); an earlier refetch would flash back the
    // optimistic edits still in flight. A failed edit is undone here.
    onSettled: () => {
      activeMutations = Math.max(0, activeMutations - 1);
      if (queryClient.isMutating({ mutationKey: MUTATION_KEY }) !== 1) return;
      void queryClient.invalidateQueries({ queryKey: LIST_KEY });
      // Invalidation only refetches when a mounted surface observes the list
      // query; without one the pills would stay stale, so force the pill poll.
      const observed =
        (queryClient.getQueryCache().find({ queryKey: LIST_KEY })?.observers.length ?? 0) > 0;
      if (!observed) recheckPills?.();
    },
  });
}

function useTodos() {
  const query = useTodoList();
  const [actionError, setActionError] = useState<string | null>(null);
  const addRpc = useRpc(addTodo);
  const toggleRpc = useRpc(toggleTodo);
  const editRpc = useRpc(editTodo);
  const noteRpc = useRpc(noteTodo);
  const removeRpc = useRpc(removeTodo);
  const moveRpc = useRpc(moveTodo);

  const add = useTodoMutation(
    addRpc,
    (data, { projectId, text }) =>
      updateFile(data, projectId, (items) => [
        ...items,
        { index: items.length, text: normalizeTaskText(text), done: false, note: "" },
      ]),
    setActionError,
  );
  const toggle = useTodoMutation(
    toggleRpc,
    (data, { projectId, index }) =>
      updateFile(data, projectId, (items) =>
        items.map((item) => (item.index === index ? { ...item, done: !item.done } : item)),
      ),
    setActionError,
  );
  const edit = useTodoMutation(
    editRpc,
    (data, { projectId, index, newText }) =>
      updateFile(data, projectId, (items) =>
        items.map((item) =>
          item.index === index ? { ...item, text: normalizeTaskText(newText) } : item,
        ),
      ),
    setActionError,
  );
  const setNote = useTodoMutation(
    noteRpc,
    (data, { projectId, index, note }) =>
      updateFile(data, projectId, (items) =>
        items.map((item) => (item.index === index ? { ...item, note } : item)),
      ),
    setActionError,
  );
  const remove = useTodoMutation(
    removeRpc,
    (data, { projectId, index }) =>
      updateFile(data, projectId, (items) => items.filter((item) => item.index !== index)),
    setActionError,
  );
  const move = useTodoMutation(
    moveRpc,
    (data, input) => moveInData(data, input),
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
    setNote: (file: TodoFile, index: number, text: string, note: string) =>
      setNote.mutate({
        projectId: file.projectId,
        index,
        text,
        note: normalizeNoteText(note),
      }),
    remove: (file: TodoFile, index: number, text: string) =>
      remove.mutate({ projectId: file.projectId, index, text }),
    move: (from: TodoFile, index: number, text: string, to: TodoFile, toIndex: number) =>
      move.mutate({ projectId: from.projectId, index, text, toProjectId: to.projectId, toIndex }),
  };
}

type TodoActions = ReturnType<typeof useTodos>;

type DragGroup = "open" | "done";

/** A measured drop area: a single item row, or a section's whole card ("end"). */
type DragZone = {
  kind: "row" | "end";
  group: DragGroup;
  file: TodoFile;
  item: TodoItem | null;
  view: View;
};

type ZoneRect = DragZone & { key: string; x: number; y: number; w: number; h: number };

type ActiveDrag = { key: string; file: TodoFile; item: TodoItem; group: DragGroup };

/** `x`/`y`/`w` locate the indicator line in window coordinates. */
type ActiveDrop = { file: TodoFile; toIndex: number; x: number; y: number; w: number };

type TodoDragContextValue = {
  dragging: ActiveDrag | null;
  register(key: string, get: () => DragZone | null): () => void;
  beginDrag(key: string, pageX: number, pageY: number): void;
  moveDrag(pageX: number, pageY: number): void;
  endDrag(commit: boolean): void;
};

const TodoDragContext = createContext<TodoDragContextValue | null>(null);

function measureWindow(view: View): Promise<{ x: number; y: number; w: number; h: number } | null> {
  return new Promise((resolve) => {
    try {
      view.measureInWindow((x, y, w, h) => resolve({ x, y, w, h }));
    } catch {
      resolve(null);
    }
  });
}

/**
 * Drag-and-drop for the todo rows of one surface. Row grips own the responder
 * (and refuse termination, so the ScrollView cannot steal the gesture); zones
 * are measured once per drag and re-measured whenever the registry changes
 * (e.g. a poll landing mid-drag). Drops report a source item plus the
 * destination file and `toIndex` understood by `todo.move`.
 */
function TodoDragProvider({
  theme,
  onDrop,
  children,
}: {
  theme: TodoTheme;
  onDrop: (
    source: { file: TodoFile; item: TodoItem },
    target: { file: TodoFile; toIndex: number },
  ) => void;
  children: ReactNode;
}) {
  const [drag, setDrag] = useState<ActiveDrag | null>(null);
  const [drop, setDrop] = useState<ActiveDrop | null>(null);
  const [ghostFrame, setGhostFrame] = useState<{ x: number; w: number } | null>(null);
  const [containerXY, setContainerXY] = useState({ x: 0, y: 0 });
  const zones = useRef(new Map<string, () => DragZone | null>());
  const zonesVersion = useRef(0);
  const measuredVersion = useRef(-1);
  const zoneRects = useRef<ZoneRect[]>([]);
  const containerRef = useRef<View>(null);
  const containerXYRef = useRef({ x: 0, y: 0 });
  const pointer = useRef({ x: 0, y: 0 });
  const pointerY = useRef(new Animated.Value(0)).current;
  const dragRef = useRef<ActiveDrag | null>(null);
  const dropRef = useRef<ActiveDrop | null>(null);
  const onDropRef = useLatest(onDrop);

  const refreshRects = useCallback(async (group: DragGroup) => {
    const entries: { key: string; zone: DragZone }[] = [];
    for (const [key, get] of zones.current) {
      const zone = get();
      if (zone && zone.group === group) entries.push({ key, zone });
    }
    const rects = await Promise.all(
      entries.map(async ({ key, zone }) => {
        const rect = await measureWindow(zone.view);
        return rect ? { key, ...zone, ...rect } : null;
      }),
    );
    zoneRects.current = rects.filter((rect): rect is ZoneRect => rect !== null);
    measuredVersion.current = zonesVersion.current;
  }, []);

  const computeDrop = useCallback((pageY: number): ActiveDrop | null => {
    for (const rect of zoneRects.current) {
      if (rect.kind !== "row" || !rect.item) continue;
      if (pageY >= rect.y && pageY <= rect.y + rect.h) {
        const after = pageY > rect.y + rect.h / 2;
        return {
          file: rect.file,
          toIndex: after ? rect.item.index + 1 : rect.item.index,
          x: rect.x,
          y: after ? rect.y + rect.h : rect.y,
          w: rect.w,
        };
      }
    }
    for (const rect of zoneRects.current) {
      if (rect.kind !== "end") continue;
      if (pageY >= rect.y && pageY <= rect.y + rect.h) {
        return { file: rect.file, toIndex: rect.file.items.length, x: rect.x, y: rect.y + rect.h, w: rect.w };
      }
    }
    return null;
  }, []);

  const updateFromPointer = useCallback(() => {
    if (!dragRef.current) return;
    const { y } = pointer.current;
    pointerY.setValue(y - containerXYRef.current.y);
    const apply = () => {
      const next = computeDrop(y);
      const prev = dropRef.current;
      if (next?.file.path !== prev?.file.path || next?.toIndex !== prev?.toIndex || next?.y !== prev?.y) {
        dropRef.current = next;
        setDrop(next);
      }
    };
    if (measuredVersion.current !== zonesVersion.current) {
      void refreshRects(dragRef.current.group).then(apply);
      return;
    }
    apply();
  }, [computeDrop, pointerY, refreshRects]);

  const beginDrag = useCallback(
    (key: string, pageX: number, pageY: number) => {
      if (dragRef.current) return;
      const zone = zones.current.get(key)?.();
      if (!zone || zone.kind !== "row" || !zone.item) return;
      const active: ActiveDrag = { key, file: zone.file, item: zone.item, group: zone.group };
      dragRef.current = active;
      pointer.current = { x: pageX, y: pageY };
      zonesVersion.current += 1;
      setDrag(active);
      const container = containerRef.current;
      if (container) {
        container.measureInWindow((cx, cy) => {
          containerXYRef.current = { x: cx, y: cy };
          setContainerXY({ x: cx, y: cy });
          pointerY.setValue(pointer.current.y - cy);
          void measureWindow(zone.view).then((rect) => {
            if (rect && dragRef.current?.key === key) {
              setGhostFrame({ x: rect.x - cx, w: rect.w });
            }
          });
        });
      }
      // Compute the drop once the fresh rects land so a quick drag still lands.
      void refreshRects(zone.group).then(updateFromPointer);
    },
    [pointerY, refreshRects, updateFromPointer],
  );

  const moveDrag = useCallback(
    (pageX: number, pageY: number) => {
      if (!dragRef.current) return;
      pointer.current = { x: pageX, y: pageY };
      updateFromPointer();
    },
    [updateFromPointer],
  );

  const endDrag = useCallback((commit: boolean) => {
    const active = dragRef.current;
    const target = dropRef.current;
    dragRef.current = null;
    dropRef.current = null;
    zoneRects.current = [];
    measuredVersion.current = -1;
    setDrag(null);
    setDrop(null);
    setGhostFrame(null);
    if (!commit || !active || !target) return;
    if (target.file.path === active.file.path) {
      const landing = target.toIndex > active.item.index ? target.toIndex - 1 : target.toIndex;
      if (landing === active.item.index) return; // Dropped where it already sits.
    }
    onDropRef.current(
      { file: active.file, item: active.item },
      { file: target.file, toIndex: target.toIndex },
    );
  }, []);

  const value = useMemo<TodoDragContextValue>(
    () => ({
      dragging: drag,
      register: (key, get) => {
        zones.current.set(key, get);
        zonesVersion.current += 1;
        return () => {
          zones.current.delete(key);
          zonesVersion.current += 1;
        };
      },
      beginDrag,
      moveDrag,
      endDrag,
    }),
    [drag, beginDrag, moveDrag, endDrag],
  );

  return (
    <TodoDragContext.Provider value={value}>
      <View ref={containerRef} collapsable={false} style={styles.fill}>
        {children}
        {drag ? (
          <View pointerEvents="none" style={StyleSheet.absoluteFill}>
            {drop ? (
              <View
                style={[
                  styles.dropLine,
                  {
                    backgroundColor: theme.colors.accent,
                    left: drop.x - containerXY.x,
                    top: drop.y - containerXY.y - 1,
                    width: drop.w,
                  },
                ]}
              />
            ) : null}
            {ghostFrame ? (
              <Animated.View
                style={[
                  styles.dragGhost,
                  {
                    left: ghostFrame.x,
                    width: ghostFrame.w,
                    backgroundColor: theme.colors.surface1,
                    borderColor: theme.colors.accent,
                    transform: [{ translateY: Animated.subtract(pointerY, 18) }],
                  },
                ]}
              >
                <Icon name="GripVertical" size={13} color={theme.colors.foregroundMuted} />
                <Text
                  numberOfLines={1}
                  style={[
                    styles.dragGhostText,
                    {
                      color: drag.item.done ? theme.colors.foregroundMuted : theme.colors.foreground,
                      textDecorationLine: drag.item.done ? "line-through" : "none",
                    },
                  ]}
                >
                  {drag.item.text}
                </Text>
              </Animated.View>
            ) : null}
          </View>
        ) : null}
      </View>
    </TodoDragContext.Provider>
  );
}

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
  file,
  group,
  onToggle,
  onEdit,
  onSetNote,
  onRemove,
}: {
  item: TodoItem;
  last: boolean;
  theme: TodoTheme;
  file: TodoFile;
  group: DragGroup;
  onToggle: (text: string) => void;
  onEdit: (text: string, newText: string) => void;
  onSetNote: (text: string, note: string) => void;
  onRemove: (text: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState(item.text);
  const [draftNote, setDraftNote] = useState(item.note);
  const [noteFocused, setNoteFocused] = useState(false);
  const [panelHeight, setPanelHeight] = useState(0);
  // Tracks the authoritative text/note for this row, including an optimistic
  // edit committed earlier in the same gesture before React has re-rendered.
  const currentText = useRef(item.text);
  const currentNote = useRef(item.note);
  const prevPropText = useRef(item.text);
  const prevPropNote = useRef(item.note);
  // The unmount cleanup sets this so an unmount blur (e.g. a removed row or
  // filter switch) can never fire a stale edit. Escape sets it too, so the
  // blur it triggers cancels the draft instead of committing it; focusing the
  // input again clears it.
  const committed = useRef(false);
  const noteCommitted = useRef(false);
  const titleInputRef = useRef<NativeTextInput>(null);
  const noteInputRef = useRef<NativeTextInput>(null);
  const expandAnim = useRef(new Animated.Value(0)).current;
  const drag = useContext(TodoDragContext);
  const rowRef = useRef<View>(null);
  const zoneKey = `${file.projectId ?? "global"}|${group}|${item.index}`;
  const zoneData = useLatest({ file, group, item });
  const lifted = drag?.dragging?.key === zoneKey;

  useLayoutEffect(() => {
    if (!drag) return;
    return drag.register(zoneKey, () => {
      const view = rowRef.current;
      const { file: zoneFile, group: zoneGroup, item: zoneItem } = zoneData.current;
      return view
        ? { kind: "row", group: zoneGroup, file: zoneFile, item: zoneItem, view }
        : null;
    });
  }, [drag, zoneKey]);

  // Props that differ from what this row last saw come from a poll, or from
  // this row's own optimistic commit echoing back. While a draft is dirty we
  // keep it and keep the stale guard text: rows are keyed by index, so a row
  // whose props changed may now be a different task, and the server must
  // refuse the commit rather than rename the wrong one.
  if (item.text !== prevPropText.current || item.note !== prevPropNote.current) {
    prevPropText.current = item.text;
    prevPropNote.current = item.note;
    const dirty =
      normalizeTaskText(draft) !== currentText.current ||
      normalizeNoteText(draftNote) !== currentNote.current;
    if (!dirty) {
      currentText.current = item.text;
      currentNote.current = item.note;
      setDraft(item.text);
      setDraftNote(item.note);
    }
  }

  // Never let an unmount blur (e.g. a removed row or filter switch) fire a stale edit.
  useLayoutEffect(
    () => () => {
      committed.current = true;
      noteCommitted.current = true;
    },
    [],
  );

  useEffect(() => {
    const animation = Animated.timing(expandAnim, {
      toValue: expanded ? panelHeight : 0,
      duration: 180,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    });
    animation.start();
    return () => animation.stop();
  }, [expanded, panelHeight, expandAnim]);

  // Idempotent: onSubmitEditing, onBlur, and collapsing can all call it, and
  // only the first call that sees a real change fires onEdit.
  const commit = (): string => {
    if (committed.current) return currentText.current;
    const next = normalizeTaskText(draft);
    const prev = currentText.current;
    if (next && next !== prev) {
      currentText.current = next;
      onEdit(prev, next);
      return next;
    }
    if (draft !== prev) setDraft(prev);
    return prev;
  };

  const commitNote = () => {
    if (noteCommitted.current) return;
    noteCommitted.current = true;
    const next = normalizeNoteText(draftNote);
    if (next !== currentNote.current) {
      currentNote.current = next;
      onSetNote(currentText.current, next);
    }
  };

  const toggleExpanded = () => {
    if (expanded) {
      commit();
      commitNote();
      // Keep the keyboard from staying up on the collapsed (height-0) inputs;
      // the blurs' commit no-ops since the drafts were just settled above.
      titleInputRef.current?.blur();
      noteInputRef.current?.blur();
      setExpanded(false);
    } else {
      noteCommitted.current = false;
      setDraft(currentText.current);
      setDraftNote(currentNote.current);
      setExpanded(true);
    }
  };

  return (
    <View
      ref={rowRef}
      collapsable={false}
      style={[
        !last && styles.divider,
        { borderBottomColor: theme.colors.border },
        lifted && styles.dragLifted,
      ]}
    >
      <View style={styles.row}>
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: item.done }}
          accessibilityLabel={`${item.done ? "Uncheck" : "Check off"} ${item.text}`}
          hitSlop={8}
          onPress={() => {
            const text = expanded ? commit() : currentText.current;
            if (expanded) commitNote();
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
        <View style={styles.rowMain}>
          {expanded ? (
            <TextInput
              ref={titleInputRef}
              value={draft}
              onChangeText={setDraft}
              autoFocus
              multiline
              submitBehavior="blurAndSubmit"
              onFocus={() => {
                committed.current = false;
              }}
              onSubmitEditing={commit}
              onBlur={commit}
              onKeyPress={({ nativeEvent }) => {
                if (nativeEvent.key === "Escape") {
                  // Cancel: the blur must not commit the dirty draft.
                  committed.current = true;
                  setDraft(currentText.current);
                  titleInputRef.current?.blur();
                }
              }}
              returnKeyType="done"
              accessibilityLabel={`Edit ${item.text}`}
              style={[styles.itemText, styles.editInput, { color: theme.colors.foreground }]}
            />
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded }}
              accessibilityLabel={`Show details of ${item.text}`}
              onPress={toggleExpanded}
              style={styles.rowTitle}
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
              {item.note ? (
                <Text style={[styles.itemNote, { color: theme.colors.foregroundMuted }]}>
                  {item.note}
                </Text>
              ) : null}
            </Pressable>
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            accessibilityLabel={`${expanded ? "Hide" : "Show"} details of ${item.text}`}
            hitSlop={8}
            onPress={toggleExpanded}
            style={styles.chevronButton}
          >
            <Icon
              name={expanded ? "ChevronUp" : "ChevronDown"}
              size={13}
              color={theme.colors.foregroundMuted}
            />
          </Pressable>
        </View>
        {drag ? (
          <View
            accessibilityRole="button"
            accessibilityLabel={`Drag to reorder ${item.text}`}
            hitSlop={6}
            onStartShouldSetResponder={() => true}
            onMoveShouldSetResponder={() => true}
            onResponderGrant={(event) =>
              drag.beginDrag(zoneKey, event.nativeEvent.pageX, event.nativeEvent.pageY)
            }
            onResponderMove={(event) =>
              drag.moveDrag(event.nativeEvent.pageX, event.nativeEvent.pageY)
            }
            onResponderRelease={() => drag.endDrag(true)}
            onResponderTerminate={() => drag.endDrag(false)}
            onResponderTerminationRequest={() => false}
            style={styles.dragHandle}
          >
            <Icon name="GripVertical" size={13} color={theme.colors.foregroundMuted} />
          </View>
        ) : null}
      </View>
      <Animated.View
        style={[
          styles.rowExpand,
          {
            height: expandAnim,
            opacity: expandAnim.interpolate({
              inputRange: [0, Math.max(panelHeight, 1)],
              outputRange: [0, 1],
              extrapolate: "clamp",
            }),
          },
        ]}
      >
        <View
          style={styles.rowPanel}
          onLayout={(event) => {
            const height = event.nativeEvent.layout.height;
            if (height !== panelHeight) setPanelHeight(height);
          }}
        >
          <TextInput
            ref={noteInputRef}
            value={draftNote}
            onChangeText={setDraftNote}
            multiline
            onFocus={() => {
              noteCommitted.current = false;
              setNoteFocused(true);
            }}
            onBlur={() => {
              setNoteFocused(false);
              commitNote();
            }}
            onKeyPress={({ nativeEvent }) => {
              if (nativeEvent.key === "Escape") {
                noteCommitted.current = true;
                setDraftNote(currentNote.current);
                noteInputRef.current?.blur();
              }
            }}
            placeholder="Add a note…"
            placeholderTextColor={theme.colors.foregroundMuted}
            accessibilityLabel={`Note for ${item.text}`}
            style={[
              styles.noteInput,
              {
                color: theme.colors.foreground,
                backgroundColor: theme.colors.surface0,
                borderColor: noteFocused ? theme.colors.accent : theme.colors.border,
              },
            ]}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Delete ${item.text}`}
            hitSlop={4}
            onPress={() => {
              committed.current = true;
              noteCommitted.current = true;
              onRemove(currentText.current);
            }}
            style={({ pressed }) => [
              styles.noteDelete,
              pressed && { backgroundColor: theme.colors.surface2 },
            ]}
          >
            <Icon name="Trash2" size={12} color={theme.colors.statusDanger} />
            <Text style={[styles.rowActionText, { color: theme.colors.statusDanger }]}>
              Delete
            </Text>
          </Pressable>
        </View>
      </Animated.View>
    </View>
  );
}

/** Rows for one file; `last` marks whether the final row ends the card (no divider). */
function TodoRows({
  items,
  file,
  group,
  theme,
  todos,
  last,
}: {
  items: TodoItem[];
  file: TodoFile;
  group: DragGroup;
  theme: TodoTheme;
  todos: TodoActions;
  last: boolean;
}) {
  return items.map((item, idx) => (
    <TodoRow
      key={item.index}
      item={item}
      last={last && idx === items.length - 1}
      theme={theme}
      file={file}
      group={group}
      onToggle={(text) => todos.toggle(file, item.index, text)}
      onEdit={(text, newText) => todos.edit(file, item.index, text, newText)}
      onSetNote={(text, note) => todos.setNote(file, item.index, text, note)}
      onRemove={(text) => todos.remove(file, item.index, text)}
    />
  ));
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
  const drag = useContext(TodoDragContext);
  // The whole section (header + card) is the "append at end" zone for both
  // groups; row zones take priority for precise positions. This also lets a
  // done item drop into a file that has no completed items yet.
  const sectionRef = useRef<View>(null);
  const zoneFile = useLatest(file);
  const baseKey = `${file.projectId ?? "global"}|${file.path}`;

  useLayoutEffect(() => {
    if (!drag) return;
    const endZone = (group: DragGroup) => () =>
      sectionRef.current
        ? { kind: "end" as const, group, file: zoneFile.current, item: null, view: sectionRef.current }
        : null;
    const offOpen = drag.register(`${baseKey}|end|open`, endZone("open"));
    const offDone = drag.register(`${baseKey}|end|done`, endZone("done"));
    return () => {
      offOpen();
      offDone();
    };
  }, [drag, baseKey]);

  return (
    <View ref={sectionRef} collapsable={false} style={styles.section}>
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

      {file.error ? (
        <EmptyCard theme={theme} text={file.error} danger />
      ) : total === 0 ? (
        <EmptyCard theme={theme} text="No tasks yet — add one below." />
      ) : (
        <View
          style={[
            styles.card,
            { backgroundColor: theme.colors.surface1, borderColor: theme.colors.border },
          ]}
        >
          <TodoRows
            items={openItems}
            file={file}
            group="open"
            theme={theme}
            todos={todos}
            last={doneItems.length === 0}
          />
          {doneItems.length > 0 ? (
            <View>
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
              </View>
              {showDone ? (
                <TodoRows
                  items={doneItems}
                  file={file}
                  group="done"
                  theme={theme}
                  todos={todos}
                  last
                />
              ) : null}
            </View>
          ) : null}
        </View>
      )}
    </View>
  );
}

function EmptyCard({
  theme,
  text,
  danger = false,
}: {
  theme: TodoTheme;
  text: string;
  danger?: boolean;
}) {
  return (
    <View
      style={[
        styles.emptyCard,
        { backgroundColor: theme.colors.surface1, borderColor: theme.colors.border },
      ]}
    >
      <Text
        style={[
          styles.emptyText,
          { color: danger ? theme.colors.statusDanger : theme.colors.foregroundMuted },
        ]}
      >
        {text}
      </Text>
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
            submitBehavior="submit"
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

/** Provider + keyboard-avoiding shell shared by the screen and the panel. */
function TodoDragSurface({
  theme,
  todos,
  children,
}: {
  theme: TodoTheme;
  todos: TodoActions;
  children: ReactNode;
}) {
  return (
    <TodoDragProvider
      theme={theme}
      onDrop={(source, to) =>
        todos.move(source.file, source.item.index, source.item.text, to.file, to.toIndex)
      }
    >
      <KeyboardAvoidingSurface style={[styles.fill, { backgroundColor: theme.colors.surface0 }]}>
        {children}
      </KeyboardAvoidingSurface>
    </TodoDragProvider>
  );
}

export function TodoScreen({ theme, layout, navigation }: PluginScreenProps) {
  const todos = useTodos();
  const [filter, setFilter] = useState<FilterMode>("all");
  const [targetProjectId, setTargetProjectId] = useState<string | null>(null);
  const { data } = todos;

  const files = data ? [data.global, ...data.projects] : [];
  // The screen hides projects with no tasks; they stay in the composer's
  // target picker so the first add can still create their TODO.md.
  const visibleFiles = (data ? visibleTodoFiles(data) : []).filter(
    (file) => filter === "all" || (file.projectId === null) === (filter === "global"),
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
    <TodoDragSurface theme={theme} todos={todos}>
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
            <EmptyCard theme={theme} text="No lists yet — add a task below to create one." />
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
    </TodoDragSurface>
  );
}

/** The Explorer list: the workspace's project, or the global list for a workspace rooted at `~`. */
function workspaceFile(data: TodoListData, projectId: string, rootPath: string): TodoFile | null {
  const project = data.projects.find((file) => file.projectId === projectId);
  if (project) return project;
  // The server tags projects whose root resolves to `~`, symlinks included.
  if (data.homeProjectIds.includes(projectId)) return data.global;
  // Fallback for a project the daemon no longer lists at all.
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
          <TodoRows items={openItems} file={file} group="open" theme={theme} todos={todos} last />
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
      if (!stopped && activeMutations === 0 && epoch === mutationEpoch) {
        publishTodoData(data);
        // Keep any mounted surface's cache in sync too; publishTodoData only
        // reaches the non-query listeners (the pills).
        todoQueryClient?.setQueryData(LIST_KEY, data);
      }
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

  const observeWorkspaces = () => {
    void client.paseo.workspaces
      .list({ includeBackground: true, subscribe: {} })
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
  const file = resolveWorkspaceFile(todos.data, workspaceId, workspace);

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
    <TodoDragSurface theme={theme} todos={todos}>
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
    </TodoDragSurface>
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
    gap: 6,
  },
  rowTitle: {
    flex: 1,
    gap: 2,
  },
  itemNote: {
    fontSize: 12,
    lineHeight: 16,
  },
  chevronButton: {
    alignItems: "center",
    justifyContent: "center",
  },
  rowExpand: {
    overflow: "hidden",
  },
  rowPanel: {
    paddingLeft: 40,
    paddingRight: 12,
    paddingBottom: 10,
  },
  noteInput: {
    minHeight: 96,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
    paddingTop: 8,
    paddingBottom: 30,
    fontSize: 12.5,
    lineHeight: 17,
    textAlignVertical: "top",
  },
  noteDelete: {
    position: "absolute",
    right: 18,
    bottom: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  rowActionText: {
    fontSize: 12,
    fontWeight: "500",
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
  dragHandle: {
    alignItems: "center",
    justifyContent: "center",
    marginRight: -4,
    paddingLeft: 4,
  },
  dragLifted: {
    opacity: 0.3,
  },
  dropLine: {
    position: "absolute",
    height: 2,
    borderRadius: 1,
  },
  dragGhost: {
    position: "absolute",
    top: 0,
    height: 36,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
  },
  dragGhostText: {
    flex: 1,
    fontSize: 13.5,
    lineHeight: 19,
  },
  editInput: {
    padding: 0,
    margin: 0,
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
