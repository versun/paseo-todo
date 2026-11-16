TODO keeps task lists in plain `TODO.md` files next to your work.

It adds a TODO screen to the sidebar and a TODO tab to the Explorer panel. The screen shows the
global list and one section per active workspace, so every list is visible in one place. The
Explorer tab shows the current workspace only. Both use the same rows and add field, and both
refresh every couple of seconds.

Items are Markdown checkboxes (`- [ ] task`). Press a row to check it off. New todos from the
global section are appended to `~/TODO.md` on the daemon machine; each workspace section appends
to `TODO.md` in that workspace's directory. Files are created on first add. The plugin reads and
writes only those files.

Workspaces that are archived or background are not listed.
