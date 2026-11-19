# paseo-todo

[English](README.md) | **中文**

一个 [Paseo](https://paseo.sh) 插件：任务列表保存在纯 Markdown
`TODO.md` 文件中 —— 一个收件箱列表（`~/TODO.md`）和每个项目一个列表
（`<project root>/TODO.md`），并呈现在应用各处。

完整功能介绍见 [OVERVIEW.md](OVERVIEW.md)。

## 功能

- TODO 页面汇总所有列表，带筛选与进度
- Explorer TODO 标签页显示当前工作区所属项目的列表
- 项目存在未完成任务时，聊天输入框上方显示 composer pill
- `/todo` 斜杠命令与 Command Center 动作
- 勾选、行内编辑、备注，拖拽排序或跨列表移动任务
- 将任务绑定到工作区，随时一键跳转回去

## 开发

```bash
npm install
npm run typecheck
npm test
```

## 许可证

MIT
