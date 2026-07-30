# Architecture: Electron desktop app

PR Dashboard is an **Electron** desktop app (not a web server). It is per-user
and single-identity: it reads GitHub tokens from the `gh` CLI you are already
signed into — no OAuth, no stored credentials.

Three layers:

- **main** (`src/main`, Node / CommonJS) — window + lifecycle, the poller, IPC
  handlers, settings (`userData/settings.json`), `gh` token resolution, and
  auto-update (`electron-updater`).
- **shared** (`src/shared`, Node) — domain logic used by main: `github.ts`
  (GraphQL query + mapping), `state.ts` (seen-state), `config.ts` (gh tokens +
  settings validation), `types.ts` (domain types **and** the renderer↔main
  contract). The renderer imports **only types** from here — never a value
  import, since these modules use `node:` builtins. **The deliberate exceptions**
  are `shared` modules kept strictly free of `node:` builtins (importing no
  module that uses them) so the renderer can value-import them: `notify.ts`
  (`DEFAULT_NOTIFICATION_SETTINGS`, the single source of truth for notification
  defaults) and `pr-filter.ts` (the whole view-filter layer: the reveal gate, the
  filter pipeline and the chips' facet counts). Keep any such
  module Node-free — a `node:` import there breaks the renderer build (Vite fails
  to bundle it). A guard test in `tests/run-tests.cjs` asserts the compiled
  `notify.js` and `pr-filter.js` stay free of `node:` builtin references, so the
  invariant can't regress unnoticed; extend that list before value-importing
  another `shared` module.
- **renderer** (`src/renderer`, Vite + React + Tailwind v4) — the dashboard UI.
  It talks to main **exclusively** through `window.api` (the preload bridge):
  no direct network, no Node access (`contextIsolation` on, `nodeIntegration`
  off).

## Build / run

- `npm run dev` — Vite dev server (HMR) + Electron pointed at it.
- `npm run build` — `tsc` (main) + `vite` (renderer) → `dist/`.
- `npm run typecheck` and `npm test` — the gate before any push.
- `npm run package` / `npm run package:dir` — electron-builder (dmg / nsis).
- `npm run release:mac` — signed + notarized macOS DMG/ZIP (needs Developer ID).

## Conventions

- Two tsconfigs: `tsconfig.main.json` (CommonJS, `rootDir: src`) and
  `tsconfig.renderer.json` (ESNext). The packaged entry is
  `dist/main/main/main.js` — keep `rootDir: src` so that path stays stable.
- New IPC channel: add the handler in `main.ts`, expose it in `preload.ts`, and
  type it on `PrManagerApi` in `shared/types.ts` (the single source of truth for
  the bridge). Validate any renderer-supplied argument in `ipc-validation.ts`.
- Settings never contain tokens; tokens are resolved per host via `gh` at fetch
  time (`config.ts`).
- `PRD_DEBUG=1` enables main-process diagnostics; `PRD_SMOKE_EXIT_MS=<ms>` makes
  `electron .` self-quit after the renderer loads (a non-interactive boot check).
