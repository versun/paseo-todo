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

const ctx = {
  paseo: {
    workspaces: { list: async () => ({ entries: [] }) },
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
const read = () => readFileSync(FILE, "utf8");
const add = (text: string, projectId: string | null = P) =>
  server.addTodoHandler({ projectId, text }, ctx);
const toggle = (index: number, text: string) =>
  server.toggleTodoHandler({ projectId: P, index, text }, ctx);
const remove = (index?: number, text?: string) =>
  server.removeTodoHandler({ projectId: P, index, text }, ctx);
const itemsOf = async () => (await server.listTodosHandler({}, ctx)).projects[0].items;

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT);
  projects = [{ projectId: P, projectRootPath: ROOT, projectDisplayName: "P1" }];
  listDelays = [];
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

describe("path resolution", () => {
  test("global add writes to ~/TODO.md", async () => {
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
});
