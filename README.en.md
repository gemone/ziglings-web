# Ziglings Web — Guided Zig Learning in the Browser

[中文文档](README.md)

A local web environment built on the [Ziglings](https://codeberg.org/ziglings/exercises/)
exercise collection — a complete learning loop in one page:

> read the exercise → look things up in **embedded, translatable docs** →
> edit in CodeMirror 6 → trial run → submit for judging → unlock chapters →
> ask the per-exercise AI tutor when stuck

## Quick start

```bash
npm install && npm run build   # build the frontend (first time)
python3 server.py              # requires zig on PATH (0.16.x verified)
# open http://127.0.0.1:8123
```

On first start the server automatically clones the ziglings repo from codeberg
and generates the exercise metadata (`NO_SYNC=1` skips this).
Environment variables: `PORT` (default 8123), `ZIG_EXE` / `ZLS_EXE`.

## Features

### Learning loop

- **Run vs Submit** — “Run” is a trial with no effect on progress; “📤 Submit”
  re-judges on the server (`zig run`, compared line-by-line against the official
  expected output, including stdout-mode, timestamp placeholder and skip flags)
  and only then records progress and a submission snapshot.
- **11-chapter ladder** — finish a chapter to unlock the next; per-chapter
  progress bars plus a free-mode toggle.
- **🧪 Scratchpad** — run any Zig code instantly, no judging; drafts auto-save
  and lint/ZLS/AI tutor all work there too.

### Editor & language services

- **CodeMirror 6** — Zig syntax highlighting (Catppuccin theme), line numbers,
  bracket closing, search, folding; `Ctrl+Enter` runs.
- **ZLS integration** — the server bridges the browser to a local zls over
  WebSocket (completions, hover).
- **Real-time lint** — `zig ast-check` diagnostics that work without ZLS.
- **Draggable splitters** — sidebar width, AI panel width and lesson height are
  all adjustable and persisted.

### AI tutor & docs

- **Per-exercise AI chat** — history persisted in localStorage; prompts carry
  the exercise, your code and the last compiler output; markdown rendering with
  copy buttons on code blocks.
- **Lesson translation** — 🌐 translates the exercise notes on demand
  (cached per exercise), ↺ switches back to the original.
- **Embedded docs + AI translation** — std library and the language reference
  render inside the Ref tab; the viewport is translated lazily as you scroll
  (code samples stay untouched).
- **Exercise ↔ docs association** — each exercise lists matching language
  reference sections plus direct links to every `std.*` symbol actually used in
  its source code.

### Misc

- Chinese / English UI (🌐 toggle), Catppuccin Mocha theme, custom scrollbars,
  auto-collapsing AI panel on narrow screens.

## Zig version switcher

The ⚙ settings dialog lists installed toolchains (scans `~/.zvm/<version>` and
PATH). Selecting a version makes the server:

1. check out the **matching upstream ziglings tag** (Zig 0.16.x → `v0.16.0`);
2. re-extract that version's exercise metadata;
3. repoint the judge/linter and zls config at the selected toolchain.

## Where data lives

| Data | Location |
|---|---|
| Exercise sources | `ziglings/exercises/*.zig` (upstream, read-only) |
| Exercise metadata | `web/data/exercises.json` (generated) |
| Code drafts | `work/runs/<exercise>.zig` |
| Progress | `work/progress.json` (written only by Submit) |
| Submissions | `work/submissions.json` |
| AI config | `work/ai_config.json` |
| Zig toolchain choice | `work/config.json` |
| Chat history | browser `localStorage` (key `chats`, per exercise) |
| Build caches | `.zigcache/` |

## Frontend build

Sources live in `src/`, bundled by esbuild into `web/dist/bundle.js`
(gitignored — build after cloning):

```
src/main.js       app logic: ladder, judging UI, chat, scratchpad
src/editor.js     CodeMirror 6 assembly (theme, keymaps, ZLS extension)
src/zig.js        Zig StreamLanguage syntax
src/transport.js  LSP WebSocket transport
src/i18n.js       zh/en dictionaries
```

## Syncing upstream

```bash
tools/sync.sh    # ziglings git pull + regenerate exercises.json
```

Progress is keyed by file name and survives updates. Delete `ziglings/` and
`web/data/exercises.json` to re-initialize from scratch on next start.

## Compatibility

- Upstream `main` targets Zig 0.17-dev; use the version switcher to check out
  `v0.16.0` — 109/116 exercises run on Zig 0.16.0.
- Exercises 96/97 (`@cImport`) are skipped upstream; exercise 105 (`zig test`)
  judges slightly differently than the CLI.
- The std docs are a WASM+SPA; the first embedded load downloads a ~16 MB
  sources.tar, and its own re-rendering can overwrite some AI translations —
  the (static) language reference is the better reading experience.
