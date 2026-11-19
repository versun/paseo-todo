# paseo-todo

**English** | [中文](README.zh-CN.md)

A [Paseo](https://paseo.sh) plugin that keeps task lists in plain Markdown
`TODO.md` files — one Inbox (`~/TODO.md`) and one per project
(`<project root>/TODO.md`) — and surfaces them throughout the app.

See [OVERVIEW.md](OVERVIEW.md) for the full feature tour.

## Features

- TODO screen aggregating every list, with filters and progress
- Explorer TODO tab for the current workspace's project
- Composer pill above the chat input while the project has open tasks
- `/todo` slash command and Command Center actions
- Check off, inline-edit, notes, and drag to reorder or move tasks
  between lists
- Bind a task to a workspace and jump back to it anytime

## Development

```bash
npm install
npm run typecheck
npm test
```

## License

MIT
