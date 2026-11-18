import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const todoItemSchema = z.object({
  index: z.number().int().nonnegative(),
  text: z.string(),
  done: z.boolean(),
  /** Extra notes for the task; stored as indented lines under it. */
  note: z.string(),
  /** Bound workspace id and display label, stored as a leading Markdown link in the note block. */
  workspaceId: z.string().nullable(),
  workspaceLabel: z.string().nullable(),
});

const todoFileSchema = z.object({
  /** `null` for the inbox ~/TODO.md. */
  projectId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  label: z.string(),
  path: z.string(),
  items: z.array(todoItemSchema),
  /** Set when the file exists but could not be read; `items` is empty then. */
  error: z.string().optional(),
});

export type TodoItem = z.infer<typeof todoItemSchema>;
export type TodoFile = z.infer<typeof todoFileSchema>;
export type TodoListData = z.infer<typeof listTodos.output>;

/** Collapse any embedded line breaks so a task is always a single Markdown line. */
export function normalizeTaskText(text: string): string {
  return text.replace(/\s*[\r\n\u2028\u2029]+\s*/g, " ").trim();
}

/** Notes keep their line breaks; each line is written indented under the task. */
export function normalizeNoteText(text: string): string {
  return text
    .split(/\r\n|[\n\r\u2028\u2029]/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Files shown on the main TODO screen: the inbox list always, and only
 * projects that have at least one task. Taskless projects stay available as
 * add targets and reappear once their first task lands.
 */
export function visibleTodoFiles(data: TodoListData): TodoFile[] {
  return [
    data.inbox,
    ...data.projects.filter((file) => file.items.length > 0 || file.error !== undefined),
  ];
}

/** The file a projectId writes to: the inbox file for `null` and `~` roots. */
export function pathFor(data: TodoListData, projectId: string | null): string | undefined {
  return projectId === null
    ? data.inbox.path
    : (data.projects.find((file) => file.projectId === projectId)?.path ??
        // Projects rooted at `~` (even via symlink) are not listed; their file
        // is the inbox one.
        (data.homeProjectIds.includes(projectId) ? data.inbox.path : undefined));
}

/** Returns `data` itself when no file changed, so no-ops keep query identity. */
function mapFiles(
  data: TodoListData,
  apply: (file: TodoFile) => TodoFile,
): TodoListData {
  const inbox = apply(data.inbox);
  const projects = data.projects.map(apply);
  if (inbox === data.inbox && projects.every((file, i) => file === data.projects[i])) {
    return data;
  }
  return { ...data, inbox, projects };
}

/** Apply an optimistic edit to the target file, and to any project sharing its path. */
export function updateFile(
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
export function moveInData(
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
  const source = [data.inbox, ...data.projects].find((file) => file.path === fromPath);
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

export const DRAG_HOLD_MS = 250;
export const DRAG_SLOP_PX = 10;
export const DRAG_SUPPRESS_PRESS_MS = 50;

/** The shared shape of touch, mouse, and pointer events: page coordinates only. */
export type DragPointEvent = {
  nativeEvent: {
    pageX?: number;
    pageY?: number;
    touches?: ArrayLike<{ pageX: number; pageY: number }>;
    changedTouches?: ArrayLike<{ pageX: number; pageY: number }>;
  };
};

export function eventPoint(event: DragPointEvent): { x: number; y: number } | null {
  const { nativeEvent } = event;
  const source =
    typeof nativeEvent.pageX === "number" && typeof nativeEvent.pageY === "number"
      ? nativeEvent
      : (nativeEvent.touches?.[0] ?? nativeEvent.changedTouches?.[0]);
  return source && typeof source.pageX === "number" && typeof source.pageY === "number"
    ? { x: source.pageX, y: source.pageY }
    : null;
}

export type DragZoneRect = {
  kind: "row" | "end";
  file: TodoFile;
  item: TodoItem | null;
  x: number;
  y: number;
  w: number;
  h: number;
};

/** `x`/`y`/`w` locate the indicator line in window coordinates. */
export type ActiveDrop = { file: TodoFile; toIndex: number; x: number; y: number; w: number };

export function computeDropTarget(
  rects: readonly DragZoneRect[],
  pageY: number,
): ActiveDrop | null {
  for (const rect of rects) {
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
  for (const rect of rects) {
    if (rect.kind !== "end") continue;
    if (pageY >= rect.y && pageY <= rect.y + rect.h) {
      return {
        file: rect.file,
        toIndex: rect.file.items.length,
        x: rect.x,
        y: rect.y + rect.h,
        w: rect.w,
      };
    }
  }
  return null;
}

/**
 * Long-press drag state machine for a surface. Holding a row for `DRAG_HOLD_MS`
 * without moving past `DRAG_SLOP_PX` starts the drag; moving past the slop
 * before the hold elapses disarms it so scrolling is unaffected. Once armed,
 * `shouldIgnorePress()` stays true across the release (`DRAG_SUPPRESS_PRESS_MS`)
 * so a trailing click/onPress on the row's controls is suppressed.
 */
export function createLongPressDrag(callbacks: {
  onBegin(key: string, pageX: number, pageY: number): boolean;
  onMove(pageX: number, pageY: number): void;
  onEnd(commit: boolean): void;
}) {
  let activeKey: string | null = null;
  let armTimer: ReturnType<typeof setTimeout> | null = null;
  let armState: { key: string; startX: number; startY: number; x: number; y: number } | null = null;
  let suppressPress = false;
  let suppressTimer: ReturnType<typeof setTimeout> | null = null;

  const cancelArm = () => {
    if (armTimer) {
      clearTimeout(armTimer);
      armTimer = null;
    }
    armState = null;
  };

  return {
    get isDragging() {
      return activeKey !== null;
    },
    arm(key: string, pageX: number, pageY: number) {
      if (activeKey !== null || armTimer !== null) return;
      if (suppressTimer) {
        clearTimeout(suppressTimer);
        suppressTimer = null;
      }
      suppressPress = false;
      armState = { key, startX: pageX, startY: pageY, x: pageX, y: pageY };
      armTimer = setTimeout(() => {
        const pending = armState;
        armTimer = null;
        armState = null;
        if (!pending) return;
        suppressPress = true;
        if (callbacks.onBegin(pending.key, pending.x, pending.y)) {
          activeKey = pending.key;
        }
      }, DRAG_HOLD_MS);
    },
    move(event: DragPointEvent) {
      const point = eventPoint(event);
      if (!point) return;
      if (armState) {
        armState.x = point.x;
        armState.y = point.y;
        if (
          Math.abs(point.x - armState.startX) > DRAG_SLOP_PX ||
          Math.abs(point.y - armState.startY) > DRAG_SLOP_PX
        ) {
          cancelArm();
        }
        return;
      }
      if (activeKey === null) return;
      callbacks.onMove(point.x, point.y);
    },
    end(commit: boolean) {
      cancelArm();
      if (suppressPress) {
        if (suppressTimer) clearTimeout(suppressTimer);
        suppressTimer = setTimeout(() => {
          suppressTimer = null;
          suppressPress = false;
        }, DRAG_SUPPRESS_PRESS_MS);
      }
      if (activeKey === null) return;
      activeKey = null;
      callbacks.onEnd(commit);
    },
    shouldIgnorePress() {
      cancelArm();
      return suppressPress || activeKey !== null;
    },
    disarmZone(key: string) {
      if (armState?.key === key) cancelArm();
    },
    dispose() {
      cancelArm();
      if (suppressTimer) {
        clearTimeout(suppressTimer);
        suppressTimer = null;
      }
    },
  };
}

export const listTodos = defineRpc({
  name: "todo.list",
  input: z.object({}),
  output: z.object({
    inbox: todoFileSchema,
    projects: z.array(todoFileSchema),
    /** Ids of projects whose root resolves to `~`; their tasks live in `inbox`. */
    homeProjectIds: z.array(z.string()),
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

/**
 * Replaces the task's note (an empty `note` clears it). `text` is the same
 * stale-index guard used by toggle/edit/remove.
 */
export const noteTodo = defineRpc({
  name: "todo.note",
  input: z.object({
    projectId: z.string().nullable(),
    index: z.number().int().nonnegative(),
    text: z.string(),
    note: z.string(),
  }),
  output: z.object({ ok: z.boolean() }),
});

/**
 * Binds or unbinds (`workspaceId: null`) a workspace on the task at `index`.
 * Stored as `[label](paseo:workspace:<id>)` at the top of the task's note
 * block. `text` is the same stale-index guard used by toggle/edit/note/remove.
 */
export const linkTodo = defineRpc({
  name: "todo.link",
  input: z.object({
    projectId: z.string().nullable(),
    index: z.number().int().nonnegative(),
    text: z.string(),
    workspaceId: z.string().trim().min(1).nullable(),
    workspaceLabel: z.string().nullable().optional(),
  }),
  output: z.object({ ok: z.boolean() }),
});

export const removeTodo = defineRpc({
  name: "todo.remove",
  input: z.object({
    projectId: z.string().nullable(),
    index: z.number().int().nonnegative(),
    /** The item text the client last saw; mismatches are refused like toggle/edit. */
    text: z.string(),
  }),
  output: z.object({ ok: z.boolean() }),
});

/**
 * Moves the item at `index` so it lands before the item at `toIndex` in the
 * destination list (pre-move numbering; `toIndex === items.length` appends).
 * Works within one file and across files; the task keeps its done state and
 * its indented note block. `text` is the same stale-index guard used by the
 * other mutations, checked against the item being moved.
 */
export const moveTodo = defineRpc({
  name: "todo.move",
  input: z.object({
    projectId: z.string().nullable(),
    index: z.number().int().nonnegative(),
    text: z.string(),
    toProjectId: z.string().nullable(),
    toIndex: z.number().int().nonnegative(),
  }),
  output: z.object({ ok: z.boolean() }),
});
