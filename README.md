# paseo-todo

A [Paseo](https://paseo.sh) plugin that keeps task lists in plain Markdown
`TODO.md` files and surfaces them in the app — one global list (`~/TODO.md`)
and one per project (`<project root>/TODO.md`).

See [OVERVIEW.md](OVERVIEW.md) for the full feature description.

## Features

- TODO screen aggregating all lists (Inbox / per-project), with progress
- Explorer TODO tab for the current workspace
- Composer pill that appears when the workspace's project has open tasks:
  shows the count, lets you check them off, and opens the Explorer tab
- `/todo [task]` slash command and Command Center actions
- Markdown checkboxes (`- [ ] task`): check, inline edit, delete — edits
  preserve the rest of the file and its line endings

## Development

```bash
npm install
npm run typecheck
npm test
```

## License

MIT
