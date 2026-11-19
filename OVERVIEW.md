TODO keeps task lists in plain Markdown `TODO.md` files on the daemon machine — an Inbox list in `~/TODO.md` plus one list per project in `<project root>/TODO.md`.

## Where tasks show up

- **TODO screen** — every list in one place, filterable by All / Inbox / Projects with open counts, a done summary, and a progress bar. The field at the top adds a task to the target picked in the chips above it (Inbox by default; taskless projects stay selectable, and the first add creates their file). The sidebar item shows the total open count.
- **Explorer TODO tab** — the current workspace's project list with its own add field, even before `TODO.md` exists. A workspace rooted at `~` gets the Inbox list; one rooted at `~/.paseo` has none.
- **Composer pill** — `TODO · N` appears above the chat input while the workspace's project has open tasks; press it to work those tasks or open the Explorer tab.
- **`/todo [task]`** — adds a task to the workspace's project list and opens the Explorer tab (no argument just opens it).
- **Command Center** — "Open TODO" and "Open workspace TODO" actions.

## Working with tasks

- Press the circle to check a task off, the text to edit it in place (Enter or clicking away saves, Esc cancels).
- Press the pencil to open the details panel: edit the note, **Link workspace**, or **Delete** the task.
- **Link workspace** binds the task to the current workspace; bound tasks show a chip that jumps straight back to it, marked archived once the workspace is gone.
- Long-press a row and drag: drop between rows to reorder, or onto another list to move the task there — it keeps its checked state and note.
- Completed tasks collapse under each list. Views refresh every couple of seconds.

## On disk

- Tasks are `- [ ]` checkboxes; indented lines under a task are its note. A bound workspace is stored as `[name](paseo:workspace:<id>)` at the top of the note and renders as a chip that opens it (shown as archived once the workspace is gone).
- `TODO.md` is created only by adding a task. Edits preserve the rest of the file and its line endings, and are refused if the file changed on disk since the view refreshed — the wrong task is never touched.
