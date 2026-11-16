# paseo-todo

A [Paseo](https://paseo.sh) plugin that keeps task lists in plain Markdown
`TODO.md` files and surfaces them in the app — one global list (`~/TODO.md`)
and one per project (`<project root>/TODO.md`).

See [OVERVIEW.md](OVERVIEW.md) for the full feature description.

## Features

- TODO screen aggregating all lists (Global / per-project), with progress
- Explorer TODO tab for the current workspace
- `/todo [task]` slash command and Command Center actions
- Markdown checkboxes (`- [ ] task`): check, inline edit, delete, clear
  completed — edits preserve the rest of the file and its line endings

## Development

```bash
npm install
npm run typecheck
npm test
```

## License

MIT
