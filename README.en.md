# Ziglings Web — Guided Zig Learning in the Browser

> 中文文档见 [README.md](README.md)。

A local web environment built on the [Ziglings](https://codeberg.org/ziglings/exercises/)
exercise collection: read the exercise → fix the code in the browser → compile & run →
automatic judging → AI tutor → std library references.

## Quick start

```bash
python3 server.py          # requires zig on PATH (0.16.x verified); auto-installs nothing else
# open http://127.0.0.1:8123
```

Environment variables: `PORT` (default 8123), `ZIG_EXE` (default `zig`),
`ZLS_EXE` (default `zls`), `NO_SYNC=1` (skip content auto-init).

On first start the server **pulls the upstream ziglings repo** (`ziglings/`) and
generates the exercise metadata (`web/data/exercises.json`) automatically.

## Features

- **CodeMirror 6 editor** — Zig syntax highlighting, line numbers, auto indent /
  bracket closing, search, folding; `Ctrl+Enter` runs the exercise.
- **ZLS language server** — the server bridges the browser to a local `zls`
  process over WebSocket (`lsp_bridge.py`), enabling completions and hover where
  ZLS works; an independent `/api/lint` (`zig ast-check`) provides real-time
  syntax squiggles regardless.
- **Run & Submit** — “Run” is a trial (no progress); “Submit” re-judges on the
  server (`zig run`, compared line-by-line against the official expected output)
  and only then records progress (`work/progress.json`) and a submission snapshot
  (`work/submissions.json`).
- **11-chapter ladder** — exercises are grouped into 11 chapters; finish one to
  unlock the next. A “free mode” toggle removes gating.
- **116 official exercises** — metadata extracted from upstream
  `rivendell/elrond.zig` by `tools/extract_exercises.py`. Sync upstream with
  `tools/sync.sh` (`git pull` + re-extract); progress is keyed by file name and
  survives updates.
- **Zig version switcher** — Settings ⚙ lists installed toolchains (zvm layout
  `~/.zvm/<version>` plus PATH). Selecting a version checks out the matching
  upstream ziglings tag (`v0.16.0` for Zig 0.16.x, etc.), re-extracts metadata,
  and repoints the judge/linter at that toolchain.
- **AI tutor** — chat panel with per-exercise persisted history
  (browser localStorage), automatic context (exercise, your code, last compiler
  errors), markdown rendering, “explain this error” one-click. Works with any
  **OpenAI-compatible endpoint** (⚙ dialog: Base URL / API Key / model), stored
  locally in `work/ai_config.json`.
- **References** — per-exercise topic cheat sheets plus links to the Zig
  language reference, std docs and Zig Learn.
- **i18n** — Chinese / English UI, toggle with the 🌐 button (top right).

## Where data lives

| Data | Location |
|---|---|
| Exercise sources | `ziglings/exercises/*.zig` (upstream repo, read-only) |
| Exercise metadata | `web/data/exercises.json` (generated) |
| Your code drafts & judge input | `work/runs/<exercise>.zig` |
| Progress | `work/progress.json` |
| Submissions | `work/submissions.json` |
| AI config | `work/ai_config.json` |
| Zig toolchain choice | `work/config.json` |
| Chat history | browser `localStorage` (key `chats`, per exercise) |
| Build caches | `.zigcache/` |

## Frontend build

Sources live in `src/` (CodeMirror 6 + a small Zig StreamLanguage + LSP client),
bundled with esbuild into `web/dist/bundle.js`:

```bash
npm install
npm run build
```

## Compatibility

- Upstream ziglings `main` targets Zig 0.17-dev; the version switcher checks out
  the matching release tag instead (verified: 109/116 exercises run on Zig 0.16.0
  at tag `v0.16.0`).
- Exercises 96/97 (`@cImport`) are skipped upstream; shown greyed out.
- Exercise 105 (`zig test`) judging may differ slightly from the CLI experience.

## Roadmap / possible next steps

- Server-side chat persistence (`work/chats/`) instead of localStorage
- Automatic upstream sync on schedule or on server start (`AUTO_SYNC`)
- More UI languages (the dictionaries live in `src/i18n.js`)
