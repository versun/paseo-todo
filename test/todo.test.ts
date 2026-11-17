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

// Pure client helper tested here so the screen's "no empty projects" rule
// cannot regress. The server tests below keep exercising the RPC layer.
const { visibleTodoFiles } = await import("../shared/todo");
type TodoFile = import("../shared/todo").TodoFile;

const fileFor = (projectId: string | null, ...doneFlags: boolean[]): TodoFile => ({
  projectId,
  workspaceId: null,
  label: projectId ?? "Global",
  path: projectId === null ? join(HOME, "TODO.md") : join(ROOT, "TODO.md"),
  items: doneFlags.map((done, index) => ({ index, text: `t${index}`, done, note: "" })),
});

describe("visibleTodoFiles", () => {
  test("projects without tasks are hidden; global and non-empty projects stay", () => {
    const files = visibleTodoFiles({
      global: fileFor(null, false),
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
      global: fileFor(null),
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
      global: fileFor(null),
      projects: [{ ...fileFor(P), error: "EISDIR" }],
      homeProjectIds: [],
    });
    assert.deepEqual(
      files.map((file) => file.projectId),
      [null, P],
    );
  });

  test("global still shows when every list is empty", () => {
    const files = visibleTodoFiles({
      global: fileFor(null),
      projects: [fileFor(P), fileFor("p2")],
      homeProjectIds: [],
    });
    assert.deepEqual(
      files.map((file) => file.projectId),
      [null],
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
const remove = (index?: number, text?: string) =>
  server.removeTodoHandler({ projectId: P, index, text }, ctx);
const setNote = (index: number, text: string, note: string) =>
  server.noteTodoHandler({ projectId: P, index, text, note }, ctx);
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

  test("clear completed keeps CRLF", async () => {
    writeFileSync(FILE, "- [x] a\r\n- [ ] b\r\n- [x] c\r\n");
    await remove();
    assert.equal(read(), "- [ ] b\r\n");
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

  test("clear completed drops notes under completed tasks only", async () => {
    writeFileSync(FILE, "- [x] a\n  note a\n- [ ] b\n  note b\n");
    await remove();
    assert.equal(read(), "- [ ] b\n  note b\n");
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

  test("clear completed without done items leaves the file untouched", async () => {
    writeFileSync(FILE, "- [ ] a\n");
    const before = statSync(FILE).ino;
    await remove();
    assert.equal(statSync(FILE).ino, before);
    assert.equal(read(), "- [ ] a\n");
  });

  test("toggle/remove never create a missing file", async () => {
    await assert.rejects(toggle(0, "a"), /changed on disk/);
    await assert.rejects(remove(0, "a"), /changed on disk/);
    await remove();
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
    assert.deepEqual(list.global.items, []);
    assert.equal(list.global.error, undefined);
  });
});

describe("path resolution", () => {
  test("global add writes to ~/TODO.md", async () => {
    rmSync(join(HOME, "TODO.md"), { force: true });
    assert.equal(existsSync(join(HOME, "TODO.md")), false);
    await add("g", null);
    assert.equal(readFileSync(join(HOME, "TODO.md"), "utf8"), "- [ ] g\n");
  });

  test("a project rooted at ~ uses ~/TODO.md; ~/.paseo and empty roots are rejected", async () => {
    const globalFile = join(HOME, "TODO.md");
    rmSync(globalFile, { force: true });
    projects = [
      { projectId: "home", projectRootPath: `${HOME}/`, projectDisplayName: "Home" },
      { projectId: "paseo", projectRootPath: join(HOME, ".paseo"), projectDisplayName: "Paseo" },
      { projectId: "empty", projectRootPath: "", projectDisplayName: "Empty" },
    ];
    await add("h", "home");
    assert.equal(readFileSync(globalFile, "utf8"), "- [ ] h\n");
    await assert.rejects(add("x", "paseo"), /Project not found/);
    await assert.rejects(add("x", "empty"), /Project not found/);
    await assert.rejects(add("x", "missing"), /Project not found/);
    const list = await server.listTodosHandler({}, ctx);
    assert.equal(list.projects.length, 0);
    assert.deepEqual(list.global.items.map((item) => item.text), ["h"]);
  });

  test("a project rooted at a symlink to ~ uses ~/TODO.md and reports homeProjectIds", async () => {
    const globalFile = join(HOME, "TODO.md");
    rmSync(globalFile, { force: true });
    const link = join(SANDBOX, "home-link");
    rmSync(link, { force: true });
    symlinkSync(HOME, link);
    projects = [{ projectId: "h", projectRootPath: link, projectDisplayName: "Home" }];
    await add("via link", "h");
    assert.equal(readFileSync(globalFile, "utf8"), "- [ ] via link\n");
    const list = await server.listTodosHandler({}, ctx);
    assert.deepEqual(list.projects, []);
    assert.deepEqual(list.homeProjectIds, ["h"]);
    rmSync(link);
  });
});
