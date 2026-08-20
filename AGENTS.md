# Architecture: Electron desktop app

PR Dashboard is an **Electron** desktop app (not a web server). It is per-user
and single-identity: it reads GitHub tokens from the `gh` CLI you are already
signed into — no OAuth, no stored credentials.

Three layers:

- **main** (`src/main`, Node / CommonJS) — window + lifecycle, the poller, IPC
  handlers, settings (`userData/settings.json`), `gh` token resolution, the tray
  icon (`tray.ts`), and auto-update (`electron-updater`). Window teardown runs
  through the tray controller (`createTrayController`), which owns the icon *and*
  the close decision together so they can't drift: close hides only while the
  `closeToTray` preference is on **and** an icon really exists (a tray that
  failed to appear must keep close quitting, or the window hides with nothing to
  restore it). The quit latch is set from every exit signal the platform gives —
  `before-quit`, the native autoUpdater's `before-quit-for-update` (macOS
  quitAndInstall closes windows before `before-quit`), and the window's
  `session-end` (Windows shutdown/logout never emits `before-quit`) — and is
  re-armed state-based when the window is next shown, never by racing the quit
  pipeline's event timing. `main.ts` only injects the live actions (focus /
  quit / hide, with a leave-fullscreen-first hide for macOS); the three-way
  close decision is unit-tested in `tests/run-tests.cjs` against a mocked
  Electron, and the wiring registrations are asserted on the compiled `main.js`.
  Close-to-tray makes hidden-but-alive the app's *normal* idle state, so the
  "no always-running animation in the renderer" rule below applies with extra
  force — a hidden renderer with an `infinite` animation burns CPU invisibly,
  and snapshot pushes are already gated on window visibility for the same
  reason.
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
- Keyboard shortcuts live in the application menu (`menu.ts`), not in renderer
  key handlers: a menu accelerator fires whatever has focus and it shows the
  user what the shortcut is. Both items forward to the renderer over IPC
  (`menu:open-settings`, `menu:refresh`) because the renderer owns the view and
  the loading state. `CmdOrCtrl` covers both platforms — Cmd+, / Cmd+R on macOS,
  Ctrl+, / Ctrl+R elsewhere. Two traps the template exists to avoid:
  `setApplicationMenu` **replaces** Electron's default menu, so the role-based
  menus have to be re-declared or Cmd+C/V/A in the search and Jira-token fields
  disappear; and the macOS `windowMenu` role omits Close, so `{ role: "close" }`
  is spelled out or Cmd+W (the close-to-tray gesture) silently stops working.
  The `reload` role must stay out — it would claim CmdOrCtrl+R and shadow
  Refresh. F5 is the second Refresh shortcut and is handled by a renderer
  `keydown` listener, because one menu item carries exactly one accelerator and
  a hidden duplicate item's accelerator is not reliable across platforms.
- Settings never contain tokens; tokens are resolved per host via `gh` at fetch
  time (`config.ts`).
- `PRD_DEBUG=1` enables main-process diagnostics; `PRD_SMOKE_EXIT_MS=<ms>` makes
  `electron .` self-quit after the renderer loads (a non-interactive boot check).
- **No always-running animation in the renderer.** An `infinite` CSS animation —
  including Tailwind's `animate-pulse` / `-spin` / `-bounce` / `-ping` — keeps the
  compositor producing frames for as long as the app is open, and Electron
  launches with `MacWebContentsOcclusion` disabled, so they keep coming even while
  the window is hidden. In v1.12.0 one 2x2px `animate-pulse` dot in the header
  was the renderer's only such animation, with `PR Dashboard Helper (GPU)` sitting
  at ~33% CPU permanently on a packaged build (removing it took a dev instance
  from 6.9% to 0.0% at idle; the dev-vs-packaged spread was never attributed, so
  treat ~33% as the observation that started this, not as a measured delta). Use
  a **finite** animation remounted via a React `key` when the underlying event
  fires — see `Buddy.tsx` (mood changes) and `.live-beat` in `styles.css` (one
  blink per snapshot). Key it on something monotonic per event: `Buddy` uses a
  run counter and `App.tsx` a snapshot counter, because `snapshot.fetchedAt` is
  the *oldest* host's stamp and stalls. A guard test in `tests/run-tests.cjs`
  scans `.ts`/`.tsx`/`.css`/`.html` under `src/renderer` for
  `animate-{pulse,spin,bounce,ping}` (bare or arbitrary-value) and for literal
  `infinite` iteration counts, so this can't regress unnoticed.
  Related: `backdrop-blur` on the sticky header is free at rest but multiplies
  the cost of anything animating beneath it (~3x in one dev-instance A/B) — keep
  animations under it short and finite.
