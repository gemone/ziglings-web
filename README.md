# Ziglings Web — 引导式 Zig 学习界面

[English](README.en.md)

基于 [Ziglings](https://codeberg.org/ziglings/exercises/) 题库的本地 Web 学习环境，
一个页面搞定完整学习闭环：

> 读题目 → **内嵌文档**查阅知识点（可 AI 翻译）→ CodeMirror 6 编辑器改代码
> → 试跑 → 提交判题 → 章节解锁爬梯 → 卡住时 AI 助教按题答疑

## 快速开始

```bash
npm install && npm run build   # 构建前端（首次）
python3 server.py              # 需要 zig 在 PATH 中（0.16.x 已验证）
# 打开 http://127.0.0.1:8123
```

首次启动会自动从 codeberg 克隆 ziglings 题库并生成练习元数据（`NO_SYNC=1` 可跳过）。
环境变量：`PORT`（默认 8123）、`ZIG_EXE` / `ZLS_EXE`。

## 功能总览

### 学习闭环

- **运行 vs 提交**：「运行」是试跑，不计进度；「📤 提交」走服务端判题
  （`zig run` 编译执行，与官方期望输出逐行比对，支持 stdout 判题、
  时间戳占位、skip 标记等官方特例），通过才计入进度并留提交快照。
- **11 章阶梯**：题库按官方脉络分 11 章，完成上一章全部题目解锁下一章；
  每章带进度条，可开启「自由模式」解除锁定。
- **🧪 实验场**：自由运行任意 Zig 代码的沙盒——无判题、自动保存，
  lint / ZLS / AI 助教全部可用，用来验证语法和 std API 很方便。

### 编辑器与语言服务

- **CodeMirror 6**：Zig 语法高亮（Catppuccin 主题）、行号、括号补全、
  搜索、折叠、多光标；`Ctrl+Enter` 直接运行。
- **ZLS 集成**：服务端 WebSocket 桥接浏览器与本机 zls（补全、悬停）。
- **实时 lint**：`zig ast-check` 提供不依赖 ZLS 的语法诊断波浪线。
- **可拖拽分栏**：侧栏宽度、AI 面板宽度、题目说明高度均可拖拽调整并记忆。

### AI 助教与文档

- **按题独立的 AI 聊天**：每题一份对话记录（localStorage 持久化），
  提问时自动携带题目、你的代码和最近编译错误；回复 markdown 渲染、代码块一键复制。
- **题目说明 AI 翻译**：🌐 一键翻译注释为中文（译文按题缓存），↺ 切回原文。
- **文档内嵌 + AI 翻译**：std 标准库 / 语言参考直接嵌在参考页签里，
  支持滚动到哪里翻译到哪里（代码示例保持原文）。
- **练习 ↔ 文档精确关联**：每题自动列出对应文档章节锚点和题目源码里
  实际用到的 std API 符号直链（如 `std.debug.print`），点击直达定义页。

### 其他

- **中英双语界面**（🌐 切换）、Catppuccin Mocha 主题、自定义滚动条、
  窄屏自动收起 AI 面板。

## Zig 版本切换

⚙ 设置里可选择本机已安装的 zig（扫描 `~/.zvm/<版本>/bin/zig` 与 PATH）。
切换后服务端自动完成三件事：

1. ziglings 仓库 checkout 到**匹配的上游 tag**（Zig 0.16.x → `v0.16.0`）；
2. 重新提取该版本题库的元数据；
3. 更新 zls 配置指向对应工具链。

## 数据存储

| 数据 | 位置 | 说明 |
|---|---|---|
| 练习元数据 | `web/data/exercises.json` | 提取脚本从上游 `elrond.zig` 生成 |
| 题目源码 | `ziglings/exercises/*.zig` | 上游仓库（只读） |
| 代码草稿 | `work/runs/<题目>.zig` | 自动保存，判题也用这份 |
| 通过进度 | `work/progress.json` | 仅由「提交」写入 |
| 提交记录 | `work/submissions.json` | 每次提交的代码与结果快照 |
| AI 配置 | `work/ai_config.json` | OpenAI 兼容接口的地址/Key/模型 |
| zig 版本选择 | `work/config.json` | 当前使用的工具链版本 |
| 聊天记录 | 浏览器 `localStorage`（key `chats`） | **每题独立**；清浏览器数据会丢失 |
| 编译缓存 | `.zigcache/` | 可随时删除 |

## 前端构建

前端源码在 `src/`，esbuild 打包为 `web/dist/bundle.js`（已 gitignore，克隆后需构建）：

```
src/main.js       应用逻辑：题单/阶梯/判题交互/聊天/实验场
src/editor.js     CodeMirror 6 装配（主题、快捷键、ZLS 扩展）
src/zig.js        Zig StreamLanguage 语法
src/transport.js  LSP WebSocket 传输
src/i18n.js       中英词典
```

## 同步上游题库

```bash
tools/sync.sh    # ziglings git pull + 重新生成 exercises.json
```

进度按文件名对应，同步不会丢。删除 `ziglings/` 与 `web/data/exercises.json`
后重启服务即可重新初始化。

## 兼容性说明

- 上游 `main` 分支要求 Zig 0.17-dev；用版本切换器 checkout `v0.16.0` tag 后，
  109/116 题可在 Zig 0.16.0 运行。
- 第 96/97 题（`@cImport`）上游标记 skip；第 105 题（`zig test`）判题体验与 CLI 略有差异。
- std 文档是 WASM+SPA，首次内嵌加载需下载 ~16MB 的 sources.tar，稍慢；
  它自身重渲染会覆盖部分 AI 译文——学习时建议以语言参考（静态页）为主。
