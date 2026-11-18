import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";

// The server module reads homedir() at load time, so point HOME at a sandbox
// before importing it. Nothing here touches the real ~/TODO.md.
const SANDBOX = mkdtempSync(join(tmpdir(), "paseo-todo-test-"));
const HOME = join(SANDBOX, "home");
const ROOT = join(SANDBOX, "project");
const FILE = join(ROOT, "TODO.md");
mkdirSync(HOME);
process.env.HOME = HOME;

const server = await import("../server/todo");

type FakeProject = { projectId: string; projectRootPath: string; projectDisplayName: string };

let projects: FakeProject[] = [];
let listDelays: number[] = [];
let workspaceEntries: Array<{
  id: string;
  projectId: string;
  name?: string;
  title?: string | null;
  archivingAt?: null;
  internal?: boolean;
  background?: boolean;
}> = [];

const ctx = {
  paseo: {
    workspaces: { list: async () => ({ entries: workspaceEntries }) },
    projects: {
      list: async () => {
        const delay = listDelays.shift() ?? 0;
        if (delay) await new Promise((done) => setTimeout(done, delay));
        return { projects };
      },
    },
  },
} as unknown as PluginHandlerContext;

const P = "p1";

// Pure client helpers tested here so the screen's visibility, optimistic move,
// and long-press drag gesture rules cannot regress. The server tests below
// keep exercising the RPC layer.
const {
  computeDropTarget,
  createLongPressDrag,
  DRAG_HOLD_MS,
  DRAG_SLOP_PX,
  DRAG_SUPPRESS_PRESS_MS,
  eventPoint,
  moveInData,
  pathFor,
  visibleTodoFiles,
} = await import("../shared/todo");
type TodoFile = import("../shared/todo").TodoFile;
type TodoListData = import("../shared/todo").TodoListData;

const fileFor = (projectId: string | null, ...doneFlags: boolean[]): TodoFile => ({
  projectId,
  workspaceId: null,
  label: projectId ?? "Inbox",
  path: projectId === null ? join(HOME, "TODO.md") : join(ROOT, projectId, "TODO.md"),
  items: doneFlags.map((done, index) => ({
    index,
    text: `t${index}`,
    done,
    note: "",
    workspaceId: null,
    workspaceLabel: null,
  })),
});

describe("visibleTodoFiles", () => {
  test("projects without tasks are hidden; inbox and non-empty projects stay", () => {
    const files = visibleTodoFiles({
      inbox: fileFor(null, false),
      projects: [fileFor(P, true), fileFor("p2"), fileFor("p3", false, true)],
      homeProjectIds: [],
    });
    assert.deepEqual(
      files.map((file) => file.projectId),
      [null, P, "p3"],
    );
  });

  test("a project whose tasks are all completed still shows", () => {
    const files = visibleTodoFiles({
      inbox: fileFor(null),
      projects: [fileFor(P, true, true)],
      homeProjectIds: [],
    });
    assert.deepEqual(
      files.map((file) => file.projectId),
      [null, P],
    );
  });

  test("a project whose file failed to read still shows so the error is visible", () => {
    const files = visibleTodoFiles({
      inbox: fileFor(null),
      projects: [{ ...fileFor(P), error: "EISDIR" }],
      homeProjectIds: [],
    });
    assert.deepEqual(
      files.map((file) => file.projectId),
      [null, P],
    );
  });

  test("inbox still shows when every list is empty", () => {
    const files = visibleTodoFiles({
      inbox: fileFor(null),
      projects: [fileFor(P), fileFor("p2")],
      homeProjectIds: [],
    });
    assert.deepEqual(
      files.map((file) => file.projectId),
      [null],
    );
  });
});

describe("long-press drag gesture", () => {
  test("eventPoint extracts coordinates from pointer, responder, and DOM touch events", () => {
    assert.deepEqual(eventPoint({ nativeEvent: { pageX: 12, pageY: 34 } }), { x: 12, y: 34 });
    assert.deepEqual(
      eventPoint({ nativeEvent: { touches: [{ pageX: 50, pageY: 60 }] } }),
      { x: 50, y: 60 },
    );
    assert.deepEqual(
      eventPoint({ nativeEvent: { touches: [], changedTouches: [{ pageX: 70, pageY: 80 }] } }),
      { x: 70, y: 80 },
    );
    assert.equal(eventPoint({ nativeEvent: {} }), null);
  });

  test("holding past DRAG_HOLD_MS starts the drag, tracks moves, and commits on release", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const events: string[] = [];
    const drag = createLongPressDrag({
      onBegin: (key, x, y) => {
        events.push(`begin:${key}:${x},${y}`);
        return true;
      },
      onMove: (x, y) => events.push(`move:${x},${y}`),
      onEnd: (commit) => events.push(`end:${commit}`),
    });

    // Duplicate start events from pointer + touch + responder capture arm only once.
    drag.arm("inbox|open|0", 10, 20);
    drag.arm("inbox|open|0", 99, 99);
    assert.equal(drag.isDragging, false);

    // Small drift within DRAG_SLOP_PX keeps the hold armed and updates the start point.
    drag.move({ nativeEvent: { pageX: 10 + DRAG_SLOP_PX, pageY: 20 - DRAG_SLOP_PX } });
    t.mock.timers.tick(DRAG_HOLD_MS);
    assert.equal(drag.isDragging, true);
    assert.deepEqual(events, [`begin:inbox|open|0:${10 + DRAG_SLOP_PX},${20 - DRAG_SLOP_PX}`]);

    // Subsequent moves (including DOM TouchEvents) forward to onMove.
    drag.move({ nativeEvent: { touches: [{ pageX: 30, pageY: 140 }] } });
    assert.deepEqual(events, [
      `begin:inbox|open|0:${10 + DRAG_SLOP_PX},${20 - DRAG_SLOP_PX}`,
      "move:30,140",
    ]);

    drag.end(true);
    assert.equal(drag.isDragging, false);
    assert.deepEqual(events, [
      `begin:inbox|open|0:${10 + DRAG_SLOP_PX},${20 - DRAG_SLOP_PX}`,
      "move:30,140",
      "end:true",
    ]);
    drag.dispose();
  });

  test("moving past DRAG_SLOP_PX before DRAG_HOLD_MS disarms so scrolling never starts a drag", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let began = false;
    const drag = createLongPressDrag({
      onBegin: () => {
        began = true;
        return true;
      },
      onMove: () => {},
      onEnd: () => {},
    });

    drag.arm("inbox|open|0", 100, 100);
    drag.move({ nativeEvent: { pageX: 100, pageY: 100 + DRAG_SLOP_PX + 1 } });
    t.mock.timers.tick(DRAG_HOLD_MS * 2);
    assert.equal(began, false);
    assert.equal(drag.isDragging, false);
    assert.equal(drag.shouldIgnorePress(), false);
    drag.dispose();
  });

  test("short taps do not start a drag and shouldIgnorePress cancels any pending hold", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let began = false;
    const drag = createLongPressDrag({
      onBegin: () => {
        began = true;
        return true;
      },
      onMove: () => {},
      onEnd: () => {},
    });

    // If a child Pressable fires onPress before pointerup (or unmounts on tap),
    // shouldIgnorePress() returns false and cancels the pending hold timer.
    drag.arm("inbox|open|0", 10, 20);
    t.mock.timers.tick(DRAG_HOLD_MS - 50);
    assert.equal(drag.shouldIgnorePress(), false);
    t.mock.timers.tick(DRAG_HOLD_MS);
    assert.equal(began, false);
    assert.equal(drag.isDragging, false);
    drag.dispose();
  });

  test("shouldIgnorePress stays true across release to block trailing clicks, then resets", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const drag = createLongPressDrag({
      onBegin: () => true,
      onMove: () => {},
      onEnd: () => {},
    });

    drag.arm("inbox|open|0", 10, 20);
    t.mock.timers.tick(DRAG_HOLD_MS);
    // pointerup runs end(true) before the browser synthesizes click -> onPress.
    drag.end(true);
    assert.equal(drag.shouldIgnorePress(), true);

    t.mock.timers.tick(DRAG_SUPPRESS_PRESS_MS);
    assert.equal(drag.shouldIgnorePress(), false);

    // Starting a new press before the suppression window elapses also resets it immediately.
    drag.arm("inbox|open|0", 10, 20);
    t.mock.timers.tick(DRAG_HOLD_MS);
    drag.end(false);
    assert.equal(drag.shouldIgnorePress(), true);
    drag.arm("inbox|open|1", 10, 50);
    assert.equal(drag.shouldIgnorePress(), false);
    drag.dispose();
  });

  test("disarmZone cancels a pending hold for that zone but never aborts an active drag", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const events: string[] = [];
    const drag = createLongPressDrag({
      onBegin: (key) => {
        events.push(`begin:${key}`);
        return true;
      },
      onMove: (x, y) => events.push(`move:${x},${y}`),
      onEnd: (commit) => events.push(`end:${commit}`),
    });

    // Unmounting before DRAG_HOLD_MS cancels that zone's pending hold.
    drag.arm("inbox|open|0", 10, 20);
    drag.disarmZone("inbox|open|1"); // different zone: ignored
    drag.disarmZone("inbox|open|0"); // armed zone: disarmed
    t.mock.timers.tick(DRAG_HOLD_MS);
    assert.equal(drag.isDragging, false);
    assert.deepEqual(events, []);

    // Once dragging, a zone re-registering on re-render must not abort the drag.
    drag.arm("inbox|open|0", 10, 20);
    t.mock.timers.tick(DRAG_HOLD_MS);
    assert.equal(drag.isDragging, true);
    drag.disarmZone("inbox|open|0");
    assert.equal(drag.isDragging, true);
    drag.move({ nativeEvent: { pageX: 15, pageY: 80 } });
    drag.end(true);
    assert.deepEqual(events, ["begin:inbox|open|0", "move:15,80", "end:true"]);
    drag.dispose();
  });

  test("computeDropTarget resolves row top/bottom halves and section end zones", () => {
    const inbox = fileFor(null, false, false);
    const rects = [
      { kind: "end" as const, file: inbox, item: null, x: 0, y: 0, w: 300, h: 200 },
      { kind: "row" as const, file: inbox, item: inbox.items[0], x: 10, y: 20, w: 280, h: 40 },
      { kind: "row" as const, file: inbox, item: inbox.items[1], x: 10, y: 60, w: 280, h: 40 },
    ];
    // Top half of row 0 -> before index 0 (y = 20).
    assert.deepEqual(computeDropTarget(rects, 30), {
      file: inbox,
      toIndex: 0,
      x: 10,
      y: 20,
      w: 280,
    });
    // Bottom half of row 0 -> after index 0 (toIndex = 1, y = 60).
    assert.deepEqual(computeDropTarget(rects, 45), {
      file: inbox,
      toIndex: 1,
      x: 10,
      y: 60,
      w: 280,
    });
    // Inside the section outside any row -> append at end (toIndex = 2, y = 200).
    assert.deepEqual(computeDropTarget(rects, 150), {
      file: inbox,
      toIndex: 2,
      x: 0,
      y: 200,
      w: 300,
    });
    // Outside all zones -> null.
    assert.equal(computeDropTarget(rects, 250), null);
  });

  test("moveInData and pathFor handle inbox, homeProjectIds, reorders, and cross-file moves", () => {
    const data: TodoListData = {
      inbox: fileFor(null, false, false),
      projects: [fileFor(P, false, true)],
      homeProjectIds: ["home-proj"],
    };
    assert.equal(pathFor(data, null), data.inbox.path);
    assert.equal(pathFor(data, "home-proj"), data.inbox.path);
    assert.equal(pathFor(data, P), data.projects[0].path);
    assert.equal(pathFor(data, "unknown"), undefined);

    // Dropping an item onto its own spot or right after itself keeps data identity.
    assert.equal(
      moveInData(data, { projectId: null, index: 0, toProjectId: null, toIndex: 0 }),
      data,
    );
    assert.equal(
      moveInData(data, { projectId: null, index: 0, toProjectId: null, toIndex: 1 }),
      data,
    );

    // Reordering within inbox updates indices.
    const reordered = moveInData(data, {
      projectId: null,
      index: 0,
      toProjectId: "home-proj",
      toIndex: 2,
    })!;
    assert.deepEqual(
      reordered.inbox.items.map((item) => [item.index, item.text]),
      [
        [0, "t1"],
        [1, "t0"],
      ],
    );

    // Moving from project P into inbox updates both lists and reindexes.
    const movedToInbox = moveInData(data, {
      projectId: P,
      index: 1,
      toProjectId: null,
      toIndex: 1,
    })!;
    assert.deepEqual(
      movedToInbox.inbox.items.map((item) => [item.index, item.text, item.done]),
      [
        [0, "t0", false],
        [1, "t1", true],
        [2, "t1", false],
      ],
    );
    assert.deepEqual(
      movedToInbox.projects[0].items.map((item) => [item.index, item.text]),
      [[0, "t0"]],
    );
  });
});

const read = () => readFileSync(FILE, "utf8");
const add = (text: string, projectId: string | null = P) =>
  server.addTodoHandler({ projectId, text }, ctx);
const toggle = (index: number, text: string) =>
  server.toggleTodoHandler({ projectId: P, index, text }, ctx);
const edit = (index: number, text: string, newText: string) =>
  server.editTodoHandler({ projectId: P, index, text, newText }, ctx);
const remove = (index: number, text: string) =>
  server.removeTodoHandler({ projectId: P, index, text }, ctx);
const setNote = (index: number, text: string, note: string) =>
  server.noteTodoHandler({ projectId: P, index, text, note }, ctx);
const link = (
  index: number,
  text: string,
  workspaceId: string | null,
  workspaceLabel?: string | null,
) => server.linkTodoHandler({ projectId: P, index, text, workspaceId, workspaceLabel }, ctx);
const move = (index: number, text: string, toIndex: number, from: string | null = P, to: string | null = P) =>
  server.moveTodoHandler({ projectId: from, index, text, toProjectId: to, toIndex }, ctx);
const itemsOf = async () => (await server.listTodosHandler({}, ctx)).projects[0].items;

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT);
  projects = [{ projectId: P, projectRootPath: ROOT, projectDisplayName: "P1" }];
  listDelays = [];
  workspaceEntries = [];
});

after(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});

describe("line endings", () => {
  test("toggle, remove and add keep CRLF", async () => {
    writeFileSync(FILE, "# T\r\n- [ ] alpha\r\n- [ ] beta\r\n");
    await toggle(1, "beta");
    assert.equal(read(), "# T\r\n- [ ] alpha\r\n- [x] beta\r\n");
    await remove(0, "alpha");
    assert.equal(read(), "# T\r\n- [x] beta\r\n");
    await add("gamma");
    assert.equal(read(), "# T\r\n- [x] beta\r\n- [ ] gamma\r\n");
  });

  test("mixed endings are preserved line by line", async () => {
    writeFileSync(FILE, "# h\n- [ ] a\r\n- [ ] b\n- [ ] c\r");
    await toggle(1, "b");
    assert.equal(read(), "# h\n- [ ] a\r\n- [x] b\n- [ ] c\r");
    await remove(0, "a");
    await add("d");
    assert.equal(read(), "# h\n- [x] b\n- [ ] c\r- [ ] d\r");
  });

  test("a file ending in a lone CR keeps every item parseable", async () => {
    writeFileSync(FILE, "- [ ] a\r");
    await add("b");
    assert.deepEqual((await itemsOf()).map((item) => item.text), ["a", "b"]);
  });

  test("add to an unterminated file inserts a separator", async () => {
    writeFileSync(FILE, "- [ ] a");
    await add("b");
    assert.equal(read(), "- [ ] a\n- [ ] b\n");
  });

  test("appends use the dominant line ending, not the first one", async () => {
    writeFileSync(FILE, "# h\n- [ ] a\r\n- [ ] b\r\n- [ ] c");
    await add("d");
    assert.equal(read(), "# h\n- [ ] a\r\n- [ ] b\r\n- [ ] c\r\n- [ ] d\r\n");
  });
});

describe("edit", () => {
  test("replaces the task text and keeps indent, marker, state and spacing", async () => {
    writeFileSync(FILE, "# T\n- [ ] alpha\n  * [X]   beta\n");
    await edit(1, "beta", "renamed");
    assert.equal(read(), "# T\n- [ ] alpha\n  * [X]   renamed\n");
    assert.deepEqual((await itemsOf()).map((item) => item.text), ["alpha", "renamed"]);
  });

  test("keeps CRLF and collapses embedded line breaks and Unicode separators", async () => {
    writeFileSync(FILE, "# T\r\n- [ ] alpha\r\n- [ ] beta\r\n");
    await edit(0, "alpha", "  one\r\ntwo\u2028three\u2029four  ");
    assert.equal(read(), "# T\r\n- [ ] one two three four\r\n- [ ] beta\r\n");
  });

  test("edit followed immediately by toggle or remove uses the updated text", async () => {
    writeFileSync(FILE, "- [ ] alpha\n- [ ] beta\n");
    await Promise.all([edit(0, "alpha", "alpha2"), toggle(0, "alpha2")]);
    assert.equal(read(), "- [x] alpha2\n- [ ] beta\n");
    await Promise.all([edit(1, "beta", "beta2"), remove(1, "beta2")]);
    assert.equal(read(), "- [x] alpha2\n");
  });

  test("stale or empty text is refused and a no-op edit does not touch the file", async () => {
    writeFileSync(FILE, "- [ ] a b\n");
    await assert.rejects(edit(0, "nope", "b"), /changed on disk/);
    await assert.rejects(edit(0, "a b", "  \r\n\u2028  "), /cannot be empty/);
    const before = statSync(FILE).ino;
    await edit(0, "a b", "a b");
    await edit(0, "a b", " a\nb ");
    assert.equal(statSync(FILE).ino, before);
    assert.equal(read(), "- [ ] a b\n");
  });

  test("edit never creates a missing file", async () => {
    await assert.rejects(edit(0, "a", "b"), /changed on disk/);
    assert.equal(existsSync(FILE), false);
  });
});

describe("note", () => {
  test("notes are written indented under the task and read back", async () => {
    writeFileSync(FILE, "- [ ] alpha\n- [ ] beta\n");
    await setNote(0, "alpha", "first\nsecond");
    assert.equal(read(), "- [ ] alpha\n  first\n  second\n- [ ] beta\n");
    const items = await itemsOf();
    assert.equal(items[0].note, "first\nsecond");
    assert.equal(items[1].note, "");
  });

  test("replacing and clearing a note rewrites the indented block", async () => {
    writeFileSync(FILE, "- [ ] alpha\n  old\n- [ ] beta\n");
    await setNote(0, "alpha", "new");
    assert.equal(read(), "- [ ] alpha\n  new\n- [ ] beta\n");
    await setNote(0, "alpha", "");
    assert.equal(read(), "- [ ] alpha\n- [ ] beta\n");
  });

  test("note on a nested task indents one level deeper", async () => {
    writeFileSync(FILE, "- [ ] top\n  - [ ] nested\n");
    await setNote(1, "nested", "deep");
    assert.equal(read(), "- [ ] top\n  - [ ] nested\n    deep\n");
  });

  test("notes survive toggle and title edit; removing a task removes its note", async () => {
    writeFileSync(FILE, "- [ ] alpha\n  note\n- [ ] beta\n");
    await toggle(0, "alpha");
    await edit(0, "alpha", "alpha2");
    assert.equal(read(), "- [x] alpha2\n  note\n- [ ] beta\n");
    await remove(0, "alpha2");
    assert.equal(read(), "- [ ] beta\n");
  });

  test("a checkbox-shaped note line stays a note and never becomes a task", async () => {
    writeFileSync(FILE, "- [ ] alpha\n- [ ] beta\n");
    await setNote(0, "alpha", "- [ ] check CI");
    const items = await itemsOf();
    assert.equal(items.length, 2);
    assert.equal(items[0].note, "- [ ] check CI");
    assert.equal(items[1].note, "");
    // The note is still reachable and replaceable; clearing removes the line.
    await setNote(0, "alpha", "plain");
    assert.equal((await itemsOf())[0].note, "plain");
    await setNote(0, "alpha", "");
    assert.equal(read(), "- [ ] alpha\n- [ ] beta\n");
  });

  test("a multi-line note mixing checkbox and plain lines stays one note", async () => {
    writeFileSync(FILE, "- [ ] alpha\n- [ ] beta\n");
    await setNote(0, "alpha", "- [ ] check CI\nplain line\n- [x] done thing");
    const items = await itemsOf();
    assert.equal(items.length, 2);
    assert.equal(items[0].note, "- [ ] check CI\nplain line\n- [x] done thing");
    assert.equal(items[1].text, "beta");
  });

  test("note on the last task of a file without a trailing newline", async () => {
    writeFileSync(FILE, "- [ ] alpha");
    await setNote(0, "alpha", "tail note");
    assert.equal(read(), "- [ ] alpha\n  tail note\n");
    assert.equal((await itemsOf())[0].note, "tail note");
  });

  test("note on a CRLF file keeps CRLF", async () => {
    writeFileSync(FILE, "- [ ] alpha\r\n- [ ] beta\r\n");
    await setNote(0, "alpha", "first\r\nsecond");
    assert.equal(read(), "- [ ] alpha\r\n  first\r\n  second\r\n- [ ] beta\r\n");
    assert.equal((await itemsOf())[0].note, "first\nsecond");
  });

  test("stale text is refused and a no-op does not touch the file", async () => {
    writeFileSync(FILE, "- [ ] a\n  same\n");
    await assert.rejects(setNote(0, "nope", "x"), /changed on disk/);
    const before = statSync(FILE).ino;
    await setNote(0, "a", "same\n");
    assert.equal(statSync(FILE).ino, before);
  });
});

describe("whitespace-only note lines", () => {
  test("a whitespace-only line does not strand the indented lines below it", async () => {
    writeFileSync(FILE, "- [ ] a\n   \n  ghost\n- [ ] b\n");
    // The blank-ish line and the line under it belong to a's note block.
    assert.equal((await itemsOf())[0].note, "ghost");
    await remove(0, "a");
    assert.equal(read(), "- [ ] b\n");
  });

  test("setting a note rewrites whitespace-only lines in the block", async () => {
    writeFileSync(FILE, "- [ ] a\n  first\n   \n  second\n- [ ] b\n");
    assert.equal((await itemsOf())[0].note, "first\nsecond");
    await setNote(0, "a", "new");
    assert.equal(read(), "- [ ] a\n  new\n- [ ] b\n");
  });
});

describe("stale-index guard", () => {
  test("mismatched text is rejected and the file is untouched", async () => {
    writeFileSync(FILE, "- [ ] a\n");
    await assert.rejects(toggle(0, "nope"), /changed on disk/);
    await assert.rejects(remove(0, "nope"), /changed on disk/);
    assert.equal(read(), "- [ ] a\n");
  });

  test("out-of-range index is rejected", async () => {
    writeFileSync(FILE, "- [ ] a\n");
    await assert.rejects(toggle(5, "a"), /changed on disk/);
  });

  test("toggle/remove never create a missing file", async () => {
    await assert.rejects(toggle(0, "a"), /changed on disk/);
    await assert.rejects(remove(0, "a"), /changed on disk/);
    assert.equal(existsSync(FILE), false);
  });
});

describe("serialization", () => {
  test("concurrent adds and toggles are all applied", async () => {
    await Promise.all(Array.from({ length: 8 }, (_, i) => add(`t${i}`)));
    assert.equal((await itemsOf()).length, 8);
    await Promise.all(Array.from({ length: 8 }, (_, i) => toggle(i, `t${i}`)));
    assert.equal((await itemsOf()).filter((item) => item.done).length, 8);
  });

  test("slow project lookup does not reorder writes", async () => {
    writeFileSync(FILE, "- [ ] a\n- [ ] b\n");
    listDelays = [30, 0];
    await Promise.all([remove(0, "a"), remove(0, "b")]);
    assert.equal(read(), "");
  });

  test("two projects aliasing one file do not lose writes", async () => {
    const alias = join(SANDBOX, "alias");
    rmSync(alias, { force: true });
    symlinkSync(ROOT, alias);
    projects.push({ projectId: "p2", projectRootPath: alias, projectDisplayName: "P2" });
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => add(`t${i}`, i % 2 ? "p2" : P)),
    );
    assert.equal(read().trim().split("\n").length, 10);
    rmSync(alias);
  });

  test("readers never observe a partial file", async () => {
    writeFileSync(FILE, Array.from({ length: 300 }, (_, i) => `- [ ] task-${i}\n`).join(""));
    let short: number | null = null;
    const poll = (async () => {
      for (let i = 0; i < 300 && short === null; i++) {
        const count = (await itemsOf()).length;
        if (count !== 300) short = count;
        await new Promise((done) => setImmediate(done));
      }
    })();
    await Promise.all([
      poll,
      ...Array.from({ length: 40 }, (_, i) => toggle(i, `task-${i}`)),
    ]);
    assert.equal(short, null);
  });
});

describe("atomic write", () => {
  test("a symlinked TODO.md stays a link and its target is updated", async () => {
    const real = join(SANDBOX, "real-todo.md");
    writeFileSync(real, "- [ ] a\n");
    symlinkSync(real, FILE);
    await toggle(0, "a");
    assert.equal(lstatSync(FILE).isSymbolicLink(), true);
    assert.equal(readFileSync(real, "utf8"), "- [x] a\n");
    rmSync(real);
  });

  test("a dangling symlink creates its target", async () => {
    const real = join(SANDBOX, "dangling-todo.md");
    rmSync(real, { force: true });
    symlinkSync(real, FILE);
    await add("first");
    assert.equal(lstatSync(FILE).isSymbolicLink(), true);
    assert.equal(readFileSync(real, "utf8"), "- [ ] first\n");
    rmSync(real);
  });

  test("permission bits survive umask", async () => {
    writeFileSync(FILE, "- [ ] a\n");
    chmodSync(FILE, 0o664);
    await toggle(0, "a");
    assert.equal(statSync(FILE).mode & 0o777, 0o664);
  });

  // root ignores directory permissions, so the fallback is never reached.
  test("falls back to in-place write when the directory is read-only", {
    skip: process.getuid?.() === 0,
  }, async () => {
    writeFileSync(FILE, "- [ ] a\n");
    chmodSync(ROOT, 0o555);
    try {
      await toggle(0, "a");
    } finally {
      chmodSync(ROOT, 0o755);
    }
    assert.equal(read(), "- [x] a\n");
  });

  test("no temp files are left behind", async () => {
    writeFileSync(FILE, "- [ ] a\n");
    await toggle(0, "a");
    await add("b");
    assert.deepEqual(readdirSync(ROOT), ["TODO.md"]);
  });
});

describe("move within a file", () => {
  test("reorders items and keeps text, state, notes and line endings", async () => {
    writeFileSync(FILE, "# T\r\n- [ ] a\r\n  note a\r\n- [x] b\r\n- [ ] c\r\n");
    await move(0, "a", 2); // insert before the item at pre-move index 2 ("c")
    assert.equal(read(), "# T\r\n- [x] b\r\n- [ ] a\r\n  note a\r\n- [ ] c\r\n");
  });

  test("moves up, down, to the top and to the end", async () => {
    writeFileSync(FILE, "- [ ] a\n- [ ] b\n- [ ] c\n");
    await move(2, "c", 0);
    assert.equal(read(), "- [ ] c\n- [ ] a\n- [ ] b\n");
    await move(0, "c", 3);
    assert.equal(read(), "- [ ] a\n- [ ] b\n- [ ] c\n");
  });

  test("moving onto itself is a no-op that does not touch the file", async () => {
    writeFileSync(FILE, "- [ ] a\n- [ ] b\n");
    const before = statSync(FILE).ino;
    await move(1, "b", 1); // same spot
    await move(1, "b", 2); // right after itself
    assert.equal(statSync(FILE).ino, before);
    assert.equal(read(), "- [ ] a\n- [ ] b\n");
  });

  test("a toIndex past the end appends at the end", async () => {
    writeFileSync(FILE, "- [ ] a\n- [ ] b\n");
    await move(0, "a", 99);
    assert.equal(read(), "- [ ] b\n- [ ] a\n");
  });

  test("an unterminated last line moved into the middle does not glue lines", async () => {
    writeFileSync(FILE, "- [ ] a\n- [ ] b");
    await move(1, "b", 0);
    assert.equal(read(), "- [ ] b\n- [ ] a\n");
  });

  test("appending after an unterminated last line still separates the tasks", async () => {
    writeFileSync(FILE, "- [ ] a\n- [ ] b");
    await move(0, "a", 2);
    assert.equal(read(), "- [ ] b\n- [ ] a\n");
  });

  test("stale text is refused and the file is untouched", async () => {
    writeFileSync(FILE, "- [ ] a\n- [ ] b\n");
    await assert.rejects(move(0, "nope", 1), /changed on disk/);
    assert.equal(read(), "- [ ] a\n- [ ] b\n");
  });

  test("inserts before the first checkbox, after heading lines", async () => {
    writeFileSync(FILE, "# T\n\n- [ ] a\n- [ ] b\n");
    await move(1, "b", 0);
    assert.equal(read(), "# T\n\n- [ ] b\n- [ ] a\n");
  });
});

describe("move between files", () => {
  const ROOT2 = join(SANDBOX, "project2");
  const FILE2 = join(ROOT2, "TODO.md");
  const read2 = () => readFileSync(FILE2, "utf8");

  const twoProjects = () => {
    rmSync(ROOT2, { recursive: true, force: true });
    mkdirSync(ROOT2, { recursive: true });
    projects = [
      { projectId: P, projectRootPath: ROOT, projectDisplayName: "P1" },
      { projectId: "p2", projectRootPath: ROOT2, projectDisplayName: "P2" },
    ];
  };

  test("moves the task with its note and done state into the other file", async () => {
    twoProjects();
    writeFileSync(FILE, "- [ ] a\n- [x] b\n  keep me\n- [ ] c\n");
    writeFileSync(FILE2, "- [ ] z\n");
    await move(1, "b", 1, P, "p2");
    assert.equal(read(), "- [ ] a\n- [ ] c\n");
    assert.equal(read2(), "- [ ] z\n- [x] b\n  keep me\n");
  });

  test("creates the destination TODO.md when missing", async () => {
    twoProjects();
    writeFileSync(FILE, "- [ ] a\n- [ ] b\n");
    await move(0, "a", 0, P, "p2");
    assert.equal(read(), "- [ ] b\n");
    assert.equal(read2(), "- [ ] a\n");
  });

  test("appending to the inbox file works", async () => {
    const inboxFile = join(HOME, "TODO.md");
    writeFileSync(FILE, "- [ ] a\n- [ ] b\n");
    rmSync(inboxFile, { force: true });
    await move(1, "b", 5, P, null);
    assert.equal(read(), "- [ ] a\n");
    assert.equal(readFileSync(inboxFile, "utf8"), "- [ ] b\n");
    rmSync(inboxFile, { force: true });
  });

  test("stale text writes neither file", async () => {
    twoProjects();
    writeFileSync(FILE, "- [ ] a\n");
    writeFileSync(FILE2, "- [ ] z\n");
    await assert.rejects(move(0, "nope", 0, P, "p2"), /changed on disk/);
    assert.equal(read(), "- [ ] a\n");
    assert.equal(read2(), "- [ ] z\n");
  });

  test("two project ids pointing at one file reorder inside it", async () => {
    const alias = join(SANDBOX, "alias");
    rmSync(alias, { force: true });
    symlinkSync(ROOT, alias);
    projects.push({ projectId: "p2", projectRootPath: alias, projectDisplayName: "P2" });
    writeFileSync(FILE, "- [ ] a\n- [ ] b\n");
    await move(0, "a", 2, P, "p2");
    assert.equal(read(), "- [ ] b\n- [ ] a\n");
    rmSync(alias);
  });
});

describe("add", () => {
  test("adding to a project without TODO.md creates the file", async () => {
    assert.equal(existsSync(FILE), false);
    await add("first");
    assert.equal(read(), "- [ ] first\n");
  });

  test("embedded newlines are collapsed into one task", async () => {
    await add("one\r\n- [ ] two\nthree");
    assert.equal(read(), "- [ ] one - [ ] two three\n");
    assert.equal((await itemsOf()).length, 1);
  });

  test("Unicode line and paragraph separators are collapsed too", async () => {
    await add("one\u2028two\u2029three");
    assert.equal(read(), "- [ ] one two three\n");
    assert.deepEqual((await itemsOf()).map((item) => item.text), ["one two three"]);
  });
});

describe("list", () => {
  test("projects without TODO.md are listed with empty items", async () => {
    const other = join(SANDBOX, "other");
    mkdirSync(other, { recursive: true });
    projects = [
      { projectId: P, projectRootPath: ROOT, projectDisplayName: "P1" },
      { projectId: "p2", projectRootPath: other, projectDisplayName: "P2" },
    ];
    writeFileSync(FILE, "- [ ] a\n");
    workspaceEntries = [{ id: "w2", projectId: "p2" }];
    const list = await server.listTodosHandler({}, ctx);
    assert.equal(list.projects.length, 2);
    const missing = list.projects.find((file) => file.projectId === "p2");
    assert.ok(missing);
    assert.deepEqual(missing.items, []);
    assert.equal(missing.path, join(other, "TODO.md"));
    assert.equal(missing.workspaceId, "w2");
    rmSync(other, { recursive: true, force: true });
  });

  test("a TODO.md that cannot be read errors only that file", async () => {
    mkdirSync(FILE); // A directory, so readFile fails with EISDIR.
    const list = await server.listTodosHandler({}, ctx);
    assert.equal(list.projects.length, 1);
    assert.deepEqual(list.projects[0].items, []);
    assert.match(list.projects[0].error ?? "", /EISDIR|directory/i);
    assert.deepEqual(list.inbox.items, []);
    assert.equal(list.inbox.error, undefined);
  });
});

describe("path resolution", () => {
  test("inbox add writes to ~/TODO.md", async () => {
    rmSync(join(HOME, "TODO.md"), { force: true });
    assert.equal(existsSync(join(HOME, "TODO.md")), false);
    await add("g", null);
    assert.equal(readFileSync(join(HOME, "TODO.md"), "utf8"), "- [ ] g\n");
  });

  test("a project rooted at ~ uses ~/TODO.md; ~/.paseo and empty roots are rejected", async () => {
    const inboxFile = join(HOME, "TODO.md");
    rmSync(inboxFile, { force: true });
    projects = [
      { projectId: "home", projectRootPath: `${HOME}/`, projectDisplayName: "Home" },
      { projectId: "paseo", projectRootPath: join(HOME, ".paseo"), projectDisplayName: "Paseo" },
      { projectId: "empty", projectRootPath: "", projectDisplayName: "Empty" },
    ];
    await add("h", "home");
    assert.equal(readFileSync(inboxFile, "utf8"), "- [ ] h\n");
    await assert.rejects(add("x", "paseo"), /Project not found/);
    await assert.rejects(add("x", "empty"), /Project not found/);
    await assert.rejects(add("x", "missing"), /Project not found/);
    const list = await server.listTodosHandler({}, ctx);
    assert.equal(list.projects.length, 0);
    assert.deepEqual(list.inbox.items.map((item) => item.text), ["h"]);
  });

  test("a project rooted at a symlink to ~ uses ~/TODO.md and reports homeProjectIds", async () => {
    const inboxFile = join(HOME, "TODO.md");
    rmSync(inboxFile, { force: true });
    const link = join(SANDBOX, "home-link");
    rmSync(link, { force: true });
    symlinkSync(HOME, link);
    projects = [{ projectId: "h", projectRootPath: link, projectDisplayName: "Home" }];
    await add("via link", "h");
    assert.equal(readFileSync(inboxFile, "utf8"), "- [ ] via link\n");
    const list = await server.listTodosHandler({}, ctx);
    assert.deepEqual(list.projects, []);
    assert.deepEqual(list.homeProjectIds, ["h"]);
    rmSync(link);
  });
});

describe("workspace link", () => {
  test("links, re-links and unlinks a task as a Markdown link in its note block", async () => {
    writeFileSync(FILE, "- [ ] alpha\n- [ ] beta\n");
    await link(0, "alpha", "wks_1", "feat-auth");
    assert.equal(read(), "- [ ] alpha\n  [feat-auth](paseo:workspace:wks_1)\n- [ ] beta\n");
    let items = await itemsOf();
    assert.equal(items[0].workspaceId, "wks_1");
    assert.equal(items[0].workspaceLabel, "feat-auth");
    assert.equal(items[0].note, "");
    assert.equal(items[1].workspaceId, null);

    await link(0, "alpha", "wks_2", "feat-billing");
    assert.equal(read(), "- [ ] alpha\n  [feat-billing](paseo:workspace:wks_2)\n- [ ] beta\n");
    items = await itemsOf();
    assert.equal(items[0].workspaceId, "wks_2");
    assert.equal(items[0].workspaceLabel, "feat-billing");

    await link(0, "alpha", null);
    assert.equal(read(), "- [ ] alpha\n- [ ] beta\n");
    items = await itemsOf();
    assert.equal(items[0].workspaceId, null);
    assert.equal(items[0].workspaceLabel, null);
  });

  test("coexists with notes: linking keeps the note, and editing or clearing the note keeps the link", async () => {
    writeFileSync(FILE, "- [ ] alpha\n  first line\n  second line\n");
    await link(0, "alpha", "wks_1", "my-ws");
    assert.equal(
      read(),
      "- [ ] alpha\n  [my-ws](paseo:workspace:wks_1)\n  first line\n  second line\n",
    );
    let item = (await itemsOf())[0];
    assert.equal(item.workspaceId, "wks_1");
    assert.equal(item.workspaceLabel, "my-ws");
    assert.equal(item.note, "first line\nsecond line");

    await setNote(0, "alpha", "updated note");
    assert.equal(read(), "- [ ] alpha\n  [my-ws](paseo:workspace:wks_1)\n  updated note\n");
    item = (await itemsOf())[0];
    assert.equal(item.workspaceId, "wks_1");
    assert.equal(item.note, "updated note");

    // Clearing the note leaves the workspace binding intact.
    await setNote(0, "alpha", "");
    assert.equal(read(), "- [ ] alpha\n  [my-ws](paseo:workspace:wks_1)\n");
    item = (await itemsOf())[0];
    assert.equal(item.workspaceId, "wks_1");
    assert.equal(item.note, "");

    // Adding a note back puts it under the workspace link, and unlinking keeps the note.
    await setNote(0, "alpha", "kept note");
    await link(0, "alpha", null);
    assert.equal(read(), "- [ ] alpha\n  kept note\n");
    item = (await itemsOf())[0];
    assert.equal(item.workspaceId, null);
    assert.equal(item.note, "kept note");
  });

  test("a note line shaped like a workspace link stays a note and never binds the task", async () => {
    writeFileSync(FILE, "- [ ] alpha\n");
    await setNote(0, "alpha", "[fake](paseo:workspace:wks_999)");
    const item = (await itemsOf())[0];
    assert.equal(item.workspaceId, null);
    assert.equal(item.workspaceLabel, null);
    assert.equal(item.note, "[fake](paseo:workspace:wks_999)");
  });

  test("list refreshes the workspace label from active workspaces and falls back when archived", async () => {
    writeFileSync(FILE, "- [ ] alpha\n  [old-name](paseo:workspace:wks_1)\n");
    workspaceEntries = [{ id: "wks_1", projectId: P, name: "renamed-ws" }];
    let item = (await itemsOf())[0];
    assert.equal(item.workspaceId, "wks_1");
    assert.equal(item.workspaceLabel, "renamed-ws");

    // A custom title wins over the generated name, like the client's `title || name`.
    workspaceEntries = [{ id: "wks_1", projectId: P, name: "renamed-ws", title: "My board" }];
    item = (await itemsOf())[0];
    assert.equal(item.workspaceLabel, "My board");

    // Once archived or gone from active entries, the stored Markdown label is used.
    workspaceEntries = [];
    item = (await itemsOf())[0];
    assert.equal(item.workspaceId, "wks_1");
    assert.equal(item.workspaceLabel, "old-name");
  });

  test("survives toggle, edit and move across files, and is removed with the task", async () => {
    const ROOT2 = join(SANDBOX, "project2");
    mkdirSync(ROOT2, { recursive: true });
    projects.push({ projectId: "p2", projectRootPath: ROOT2, projectDisplayName: "P2" });
    writeFileSync(FILE, "- [ ] alpha\n");
    await link(0, "alpha", "wks_1", "worktree-a");
    await toggle(0, "alpha");
    await edit(0, "alpha", "alpha2");
    await move(0, "alpha2", 0, P, "p2");
    const list = await server.listTodosHandler({}, ctx);
    const p2Item = list.projects.find((file) => file.projectId === "p2")!.items[0];
    assert.equal(p2Item.text, "alpha2");
    assert.equal(p2Item.done, true);
    assert.equal(p2Item.workspaceId, "wks_1");
    assert.equal(p2Item.workspaceLabel, "worktree-a");
    rmSync(ROOT2, { recursive: true, force: true });
  });

  test("sanitizes brackets and line breaks in label, keeps CRLF, and ignores no-ops", async () => {
    writeFileSync(FILE, "- [ ] alpha\r\n");
    await link(0, "alpha", "wks_1", "[WIP]\r\nmy-branch");
    assert.equal(read(), "- [ ] alpha\r\n  [WIP my-branch](paseo:workspace:wks_1)\r\n");
    const before = statSync(FILE).ino;
    await link(0, "alpha", "wks_1", "[WIP] my-branch");
    assert.equal(statSync(FILE).ino, before);
    await link(0, "alpha", null);
    const afterUnlink = statSync(FILE).ino;
    await link(0, "alpha", null);
    assert.equal(statSync(FILE).ino, afterUnlink);
    await assert.rejects(link(0, "nope", "wks_1", "x"), /changed on disk/);
  });
});

