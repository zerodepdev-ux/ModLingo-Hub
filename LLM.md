# LLM.md — technical reference for language models and AI agents

> You are reading the long-form guide. Short rules for coding agents are in [`AGENTS.md`](AGENTS.md); human-oriented docs are in [`README.md`](README.md) and
> [`tools/livemod/README.md`](tools/livemod/README.md) (both in French). If something here contradicts the code, **the code wins** — and please fix this file.

## 1. What this project is

**ModLingo-Hub-live** (beta, `0.2.0-beta.1`) is the command-line edition of ModLingo-Hub, a tool that translates game mods **on the user's machine**.

- **Interactive translation UI** (`Livemod_inteface.js`): `minecraft scan`, `bg3 scan` — finds the user's mods, analyses them, asks what to translate, translates, writes the result.
- **MCP server** (`livemod.js`): lets AI clients read translation caches/glossaries. **Read-only** — it cannot translate or write.
- **Portable build** (`build.sh` / `build.ps1` / `build.js`): produces a self-contained folder with its own Node.js runtime.

Supported games: **Minecraft** (mods, FTB Quests, KubeJS, BetterQuesting) and **Baldur's Gate 3**. Minecraft output is always French (`fr_fr`). BG3 supports the 16 languages the game can display.

The repository intentionally contains **no game text, no caches, no API keys, no personal data**.

## 2. Repository map

```
tools/livemod/
  livemod.js            CLI entry + MCP server (stdio and HTTP) + MCP shell. Commands: start|stop|info|data|edit|add|connect|update-node|shell|ui|setup|version
  Livemod_inteface.js   Interactive translation UI (no dependencies): wizard, history, Tab completion, game flows, i18n helper T()
  paths.js              Decides layout: "repo" (inside this repo) vs "portable" (folder with Dependence/). Single source for ROOT, STATE, SERVER_SCRIPT
  node-update.js        Verified update of the portable Node (same major, LTS, SHA-256, applied by the launcher on next start)
  version.js            Version string (single source)
  build.js              Assembles the portable folder (copies project files + npm packages; closure computed from require())
  build.sh / build.ps1  Download Node (+ SHA-256 check), npm ci if needed, then run build.js
  LiveMod.sh / .cmd     Launchers (prefer Dependence/node, then node, bun, nvm, distrobox)
  tradution/server-lite.js   Minimal translation server copied into the portable folder (Minecraft + BG3 routes only)
  locales/en.json       English strings. French is the source language (no file)
  test.js, test-interface.js, test-build.js   Test suites (no real translation engine is ever called)
modules/ translator.js main.js lspk.js verify-pak.js   Translation engine & game modules (shared with the full ModLingo-Hub app)
data/                   Only: minecraft glossary + tag filter, ExSave.env (settings template), version.json
```

## 3. Layouts and state

| | repo layout | portable layout |
|---|---|---|
| detected by | `Dependence/` absent next to `paths.js` | `Dependence/` present |
| state dir (`STATE`) | `<repo>/.livemod/` | `<folder>/config/` |
| translation server | `<repo>/server.js` (full app) | `Dependence/Tradution/server-lite.js` |
| Node | whatever runs it | `Dependence/node` |

`LIVEMOD_STATE` overrides the state dir (used by every test). State files: `config.json` (port, web, allowRead, maxReadBytes, dataDir, nodeUpdate, **token**), `interface.json` (language, target language, games, remembered paths, setup flag),
`history`, `tools.d/`, `commands.d/`, `livemod.pid`, `livemod.log`, `server.log`, `node-update.json`, `node-update.log`.
`config.json` contains the MCP bearer token: it is written with mode `0600` and must never be printed to logs, committed, or copied.

## 4. Environment variables

`LIVEMOD_STATE` state dir · `LIVEMOD_HOME` home dir used for launcher/game detection (tests) · `LIVEMOD_MEDIA` mount root scanned for Windows partitions (default `/run/media`) · `LIVEMOD_APP_CONFIG` path of the app config read for the BG3 mods folder ·
`LIVEMOD_APP_URL` use **only** this translation server (disables port probing) · `LIVEMOD_LANG` UI language override · `LIVEMOD_NO_SETUP=1` skip first-run wizard · `LIVEMOD_NO_UPDATE=1` skip Node update check ·
`LIVEMOD_NODE` path to a Node binary for the launcher · `LIVEMOD_BOX` distrobox name that contains node · `LIVEMOD_NPM_CLI` npm-cli.js override for build scripts · `LIVEMOD_NODE_DIST` Node distribution base URL (https only, plain http only for 127.0.0.1) ·
`LIVEMOD_VERBOSE` mirror server log lines to stderr · `TRANSLATOR_PORT` extra port to probe for the app server · `PORT` port of `server-lite.js` (default 3951).

## 5. Translation flow

1. `Livemod_inteface.js` looks for a translation server: `LIVEMOD_APP_URL`, else `TRANSLATOR_PORT`, 3000, 3949, 3951. If none, it asks the user, then spawns `SERVER_SCRIPT` on port 3951 with `process.execPath` and **stops it on exit**.
2. `withAppConfig()` temporarily points the server's folder setting (`minecraftInstancesFolder` or `modsFolder`) at the user's choice — **after asking** — and always restores it (also on cancel/error).
3. **Minecraft**: local scan reads `.jar` central directories itself (no dependency), counts `en_us` vs `fr_fr` keys per namespace, detects FTB Quests / KubeJS / BetterQuesting. Then calls `/api/minecraft/mods-translate` → `/api/minecraft/mods-resourcepack`
   (resource pack `FR_Traduction_*.zip`), and the `ftbquest-*`, `kubejs-*`, `bq-*` routes. FTB chapter files are backed up to `livemod-backup/` before being rewritten.
4. **BG3**: finds the `Mods` folder locally (Steam/Proton libraries, Windows, mounted Windows partitions, app config, remembered paths), lists mods via `/api/paks`, checks each with `/api/pak/<name>/has-language?lang=xx`,
   translates with the SSE stream `GET /api/translate/stream?pak=…&lang=…` (server spawns `main.js`, output `<mod>_<lang>.pak`). `BG3_LANGS` in the interface mirrors `BG3_LANG_FOLDERS` in `modules/shared.js` (a test guards against drift).
5. Secrets (DeepL/OpenRouter/Gemini keys) are typed with echo disabled and sent only to the local server's `/api/save-env/config`. They are never logged or stored by this tool.

## 6. MCP server

- Transports: stdio (`livemod.js start --stdio`, no token) and HTTP `http://127.0.0.1:3950/mcp` (`Authorization: Bearer <token>`, JSON-RPC 2.0, batch supported).
- Tools (all read-only): `project_info`, `translation_stats`, `lookup_translation`, `search_translations`, `get_glossary`, `list_modules`, `recent_changes`, `read_project_file`. Custom tools: `.js` files in `tools.d/` exporting `{ name, description, inputSchema, run(args, ctx) }`.
- Hardening: loopback only; `Host` and `Origin` must be local (anti DNS-rebinding/CSRF); timing-safe token compare; `read_project_file` refuses paths outside the project root and anything matching the DENY list (`.git`, `node_modules`, `.livemod`, `APIcle.json`, `.env*`, keys/certs, `Save_Autre`); 1 MB request cap.
- Data directory: config `dataDir`, else (repo layout only) the directory whose `cache.json` changed last, else `<root>/data`. In the portable layout only `Dependence/Tradution/data` is used.

## 7. Internationalisation

`T('Texte français', arg0, arg1)` returns the text for the current language; `{0}`, `{1}` are positional placeholders. **French strings are the keys.** A language is a file `locales/<code>.json` with `_name` and a French→target map; a missing string falls back to French.
`test-interface.js` extracts every `T('…')` from the source and fails if `locales/en.json` misses one or contains an unused one — so **adding or editing a UI string requires updating `locales/en.json`**.

## 8. How to…

- **Add a UI language**: copy `locales/en.json` to `locales/<code>.json`, set `_name`, translate values. It appears in the first-run wizard automatically.
- **Add a game**: add it to `GAMES` and `HANDLERS` in `Livemod_inteface.js` (`select`, `show`, `guided`), implement detection + analysis + translation through the app server's routes, add French strings via `T()` and their English values, add tests with the mock server in `test-interface.js`, update `help trad` expectations.
- **Add an MCP tool**: append to `BUILTIN` in `livemod.js` (read-only!) and add a case in `test.js`.
- **Change what the portable build copies**: edit `ENTRIES` in `build.js` (closure of `require()` is computed automatically).

## 9. Tests

```
npm ci
node tools/livemod/test.js              # MCP server (stdio + HTTP), uses fabricated data
node tools/livemod/test-interface.js    # translation UI against a mock translation server
node tools/livemod/test-build.js        # portable build offline (--node-bin), lite server, Node update against a fake nodejs.org
```
Rules: tests must be hermetic (set `LIVEMOD_STATE`, `LIVEMOD_HOME`, `LIVEMOD_MEDIA`, `LIVEMOD_APP_CONFIG`, `LIVEMOD_NO_UPDATE=1`), must **never** call a real translation engine or a real running app, and must not depend on files outside the repo.

## 10. Known limitations (be honest about them)

- Minecraft translation is French only; only two games are supported.
- `build.ps1` and `LiveMod.cmd` (Windows) have not been run on a real Windows machine.
- The portable Node download is verified with SHA-256 from `SHASUMS256.txt` over HTTPS; **GPG signatures are not verified**.
- The full first BG3 analysis can be slow on large mod folders (one `has-language` request per mod).
- Translation quality depends on the engine the user configured.

## 11. Rules that apply to you

- Do not add network calls to unofficial or undocumented endpoints; do not add or commit game files, translation caches, API keys, tokens, or personal paths.
- Do not weaken the MCP hardening in §6 or make the MCP server write anything.
- Ask the human before downloading files, changing their app configuration, or publishing anything.
- Keep the zero-dependency property of `livemod.js`, `Livemod_inteface.js`, `node-update.js`, `build.js`.
