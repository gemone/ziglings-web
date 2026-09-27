# Ziglings Web — 引导式 Zig 学习界面

基于 [Ziglings](https://codeberg.org/ziglings/exercises/) 题库的本地 Web 学习环境：
阅读题目说明 → 在浏览器里改代码 → 一键编译运行 → 自动判题 → AI 助教答疑 → 查阅 std 文档。

## 快速开始

```bash
python3 server.py          # 需要 zig 在 PATH 中（0.16.x 已验证）
# 打开 http://127.0.0.1:8123
```

环境变量：`PORT`（默认 8123）、`ZIG_EXE`（默认 `zig`）。

## 功能

- **CodeMirror 6 编辑器**：Zig 语法高亮、行号、自动缩进/括号补全、搜索、
  多光标、行折叠；`Ctrl+Enter` 直接运行。
- **ZLS 语言服务**：服务端通过 WebSocket 桥接浏览器与 ZLS（每个连接一个 zls 进程，
  `lsp_bridge.py` 负责 LSP `Content-Length` 帧 ↔ WS 裸 JSON 的转换），
  支持自动补全、悬停类型信息等；代码草稿自动保存到 `work/runs/`。
  另有独立的 `/api/lint`（基于 `zig ast-check`）提供与 ZLS 无关的实时语法诊断波浪线。
- **运行 + 提交（判题）**：「运行」试跑不计进度；「提交」走服务端判题
  （`zig run` 编译执行，与官方期望输出逐行比对，支持 stdout 判题、时间戳占位等特例），
  通过才记入进度并保存提交记录（`work/submissions.json`）。
- **11 章阶梯解锁**：题库按官方脉络分为 11 章，完成上一章全部题目后解锁下一章；
  每章显示进度条，侧栏顶部可开启「自由模式」解除锁定。
- **116 道官方练习**：题目、期望输出、提示等元数据由 `tools/extract_exercises.py`
  从 ziglings 的 `rivendell/elrond.zig` 自动提取（`ziglings/` 仓库已内嵌，可 `git pull` 后重新提取）。
- **AI 助教**：右侧对话面板，自动携带当前题目、你的代码和最近的编译错误作为上下文；
  一键「让 AI 解释」分析报错；快捷按钮「解释题意 / 要提示不要答案」。
  在右上角 ⚙ 填写任意 **OpenAI 兼容接口**（Base URL / API Key / 模型），
  配置存于本地 `work/ai_config.json`，仅发往你填写的地址。
- **参考资料**：每题自动匹配知识点速查（if/while/错误处理/comptime/指针/向量…），
  外链 Zig 0.16 语言参考、std 标准库文档、Zig Learn 等。

## 前端构建

前端源码在 `src/`（CodeMirror 6 + 自带 Zig StreamLanguage + LSP 客户端），
用 esbuild 打包为 `web/dist/bundle.js`：

```bash
npm install
npm run build        # esbuild src/main.js --bundle --minify --outfile=web/dist/bundle.js
```

`web/index.html` 只引用打包产物，无需其他构建步骤。

## ZLS 说明

- ZLS 桥接基于本机安装的 `zls`（环境变量 `ZLS_EXE` 可覆盖），
  配置文件 `work/runs/zls.json` 指定了工作区内的 global cache 等路径。
- 在本项目的受限沙箱环境中 ZLS 的语义分析（补全/诊断）可能静默失效
  （HOME 只读导致 zig 缓存写入失败）；在正常桌面环境下功能完整。
  无论 ZLS 状态如何，「运行 / 提交」的完整编译判题与 `/api/lint` 实时语法检查始终可用。

## 目录结构

```
server.py               本地服务（Python 标准库，无第三方依赖）
tools/extract_exercises.py  元数据提取脚本
web/                    前端（原生 HTML/CSS/JS，无构建步骤）
  data/exercises.json   生成的练习元数据
ziglings/               上游仓库（题目源码与补丁）
work/                   用户代码草稿、进度、AI 配置（可整目录删除以重置）
.zigcache/              zig 编译缓存
```

## 数据存储

| 数据 | 位置 | 说明 |
|---|---|---|
| 练习元数据 | `web/data/exercises.json` | 由提取脚本从上游 `elrond.zig` 生成 |
| 题目源码 | `ziglings/exercises/*.zig` | 上游仓库原始文件（只读，不修改） |
| 你的代码草稿 | `work/runs/<题目>.zig` | 编辑器自动保存；判题也用这份 |
| 通过进度 | `work/progress.json` | 文件名 → true |
| 提交记录 | `work/submissions.json` | 每次提交的代码与结果快照 |
| AI 配置 | `work/ai_config.json` | OpenAI 兼容接口的地址/Key/模型 |
| 聊天记录 | 浏览器 `localStorage`（key `chats`） | **每题独立**；清浏览器数据会丢失 |
| zig 编译缓存 | `.zigcache/` | 可随时删除 |

## 同步上游题库

服务启动时会自动初始化：`ziglings/` 不存在则从 codeberg 克隆，`exercises.json` 不存在则自动提取。
题目更新（上游新增练习后）手动执行：

```bash
tools/sync.sh    # git pull + 重新生成 exercises.json
```

进度按文件名对应，同步后已完成的题不会丢。想让目录回到"裸仓库"状态重新初始化：
删除 `ziglings/` 和 `web/data/exercises.json` 后重启 `python3 server.py`（或设 `NO_SYNC=1` 跳过初始化）。

## 兼容性说明

- 题库上游要求 Zig 0.17-dev，但已验证 109/116 题在 Zig 0.16.0 下可直接编译运行。
- 第 96/97 题（`@cImport` 练习）被上游标记为 skip，界面中以灰色「⏭」显示。
- 第 105 题（testing）使用 `zig test` 语义，判题可能与 CLI 体验略有差异。
