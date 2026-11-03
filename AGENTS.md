# AGENTS.md

Instructions for AI coding agents working in this repository. **If you are a language model, read [`LLM.md`](LLM.md) for the full technical reference** (architecture, flows, environment variables, tests, limitations).

## Project in one paragraph
ModLingo-Hub-live is a zero-dependency Node.js command-line tool (`tools/livemod/`) that translates Minecraft and Baldur's Gate 3 mods on the user's machine, plus a read-only MCP server and a script that builds a portable folder with its own Node.js. Docs for humans are in French.

## Setup and checks
```bash
npm ci
node tools/livemod/test.js && node tools/livemod/test-interface.js && node tools/livemod/test-build.js
```
All three must pass before you propose a change. They are hermetic and never contact a translation engine.

## Where things are
- UI: `tools/livemod/Livemod_inteface.js` · CLI/MCP: `tools/livemod/livemod.js` · layout: `tools/livemod/paths.js` · build: `tools/livemod/build.{js,sh,ps1}` · strings: `tools/livemod/locales/`.
- Engine and game modules (`translator.js`, `main.js`, `modules/`) are shared with the full app: keep changes there minimal and discuss first.

## Conventions
- Node 18+ compatible, CommonJS, `'use strict'`, 4-space indent, single quotes. No new runtime dependencies in the four zero-dependency files.
- User-facing text is **French source text wrapped in `T('…')`**; every new or changed string needs its English value in `locales/en.json` (a test enforces this).
- Comments in French, explaining *why*. Match the surrounding style.
- New behaviour needs a test in the suite that covers it, using the mock servers/fixtures already there.

## Never
- Commit or print API keys, the MCP token (`config.json`), user paths, game files, caches, or anything from `.livemod/`, `config/`, `dist/`.
- Add calls to unofficial/undocumented web endpoints, or make the MCP server able to write or translate.
- Run tests or experiments against the user's real translation app or real game folders. Use fixtures and the `LIVEMOD_*` isolation variables.
- Download, install, publish, or change a user's configuration without asking.

## Pull requests
Small and focused; say what changed and why; mention which tests you ran; update `CHANGELOG.md` and `locales/en.json` when relevant. See [`CONTRIBUTING.md`](CONTRIBUTING.md).
