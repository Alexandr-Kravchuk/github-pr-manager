# План: десктоп-додаток (Electron) замість спільного сервера

> **Чому пивот.** Спільний сервер + власний OAuth App тягне залежність від **enterprise-owner**
> на GHE (EMU забороняє керованим користувачам авторизувати сторонні застосунки). Per-user
> десктоп на `gh`-токені знімає це повністю: кожен користувач діє своїми обліковими (як уже
> працює `localhost:3737` через `gh auth token`). OAuth/Tier-B робота (гілка `feature/oauth-login`)
> **не мерджиться** — вона була під серверну модель.
>
> Створено: 2026-06-16. Рішення: Electron (а не Tauri/локальний сервіс) — бо бекенд це Node-логіка,
> і вже є налагоджений Electron-тулчейн у `adac-setup-wizard` (electron-builder, mac sign/notarize,
> win nsis, CI). Apple Developer ID наявний → mac-автооновлення розблоковано.

## 1. Рішення (зафіксовано)
- **Оболонка:** Electron, нативний (renderer = Vite+React, main = Node-бекенд через IPC) — як `adac-setup-wizard`. Не «Next-сервер у коробці».
- **Tauri відхилено:** бекенд на Node → потребував би Rust-переписування або Node-sidecar; + новий тулчейн проти готового Electron.
- **Аудиторія:** команда/колеги → потрібні підписані інсталятори + автооновлення.
- **Креди:** `gh` CLI (`gh auth token --hostname …`), як зараз. Детект відсутнього/незалогіненого `gh` → інструкція в UI. (PAT-fallback — опційно пізніше.)
- **Репозиторій:** цей же `github-pr-manager`. **Гілкуємось від `main`** (простий single-identity gh-код), не від `feature/oauth-login`.
- **Single-user:** викидаємо OAuth, JWE-сесію, auth-gate, Tier-B, broadcast-канали, config-as-credential.

## 2. Архітектурний мепінг (Next → Electron)
| Шар | Зараз (Next) | Electron |
|---|---|---|
| UI | `src/app/page.tsx`, `components/PrCard`, `CheckBadge`, `lib/format` | renderer (Vite+React) — **порт майже 1:1**, `"use client"` геть |
| Дані (initial) | `GET /api/pull-requests` | IPC `invoke("pull-requests")` |
| Live | SSE `GET /api/stream` | IPC-події `webContents.send("snapshot"/"config-error")` |
| Mark seen | `POST /api/seen` | IPC `invoke("mark-seen", items)` |
| Конфіг | `GET /api/config` | IPC `invoke("get-config")` + settings-UI |
| Доменна логіка | `lib/github.ts`, `lib/state.ts`, `lib/types.ts` | **переюз у `src/shared` / `src/main`** (Node) |
| Поллер | `lib/poller.ts` (single, з main-гілки) | таймер у main-процесі, `webContents.send` замість publish |
| Токени | `lib/config.ts` `resolveToken` (`gh`) | той самий резолв у main |
| Налаштування | `config.json` (credential) | settings-файл у `app.getPath("userData")`: hosts/repos/interval, **без токенів** |

**Порт 1:1:** `github.ts`, `state.ts`, `types.ts`, `format.ts`, `PrCard`, `CheckBadge`, основна розмітка `page.tsx`.
**Переписати:** транспорт (HTTP/SSE → IPC), поллер publish→`webContents.send`, читання config→settings, точка входу.
**Викинути:** `app/api/*`, `app/login`, `session.ts`, `oauth.ts`, auth-gate, `broadcast.ts` (канали), Tier-B.

## 3. Структура (дзеркаля adac-setup-wizard)
```
src/
  main/
    main.ts            # вікно, lifecycle, реєстрація IPC, поллер-таймер, autoUpdater
    preload.ts         # contextBridge: invoke + on(snapshot/config-error)
    ipc-validation.ts  # валідація IPC-аргументів
    poller.ts          # single poller → webContents.send
    settings.ts        # read/write userData/settings.json
  shared/
    github.ts          # ⟵ переюз
    state.ts           # ⟵ переюз (seen-state у userData)
    config.ts          # резолв gh-токена (+ детект gh)
    types.ts           # ⟵ переюз
  renderer/
    index.html
    App.tsx            # ⟵ page.tsx без Next
    components/PrCard.tsx, CheckBadge.tsx
    format.ts
    settings/          # UI налаштувань (hosts/repos/interval)
build/                 # icon.*, entitlements.mac*.plist (як у wizard)
scripts/release-mac.sh # ⟵ адаптувати з wizard
```
electron-builder `build` у `package.json`: appId напр. `com.creatio.prdashboard`, mac universal dmg (hardenedRuntime+entitlements), win nsis. **+ `publish` (GitHub Releases) для electron-updater.**

## 4. Автооновлення
- `electron-updater`: перевірка фіду при старті + періодично → фонове завантаження → «Update → Restart».
- Фід: **GitHub Releases** особистого репо `Alexandr-Kravchuk/github-pr-manager` (для колег — або публічні релізи, або токен; уточнити). Альтернатива — внутрішня HTTP/шара (`generic` provider).
- mac: автооновлення вимагає Developer ID-підпису → переюз `release-mac.sh` (sign+notarize+staple). win: nsis + (бажано) code-sign.
- CI: GH Actions — win-білд створює реліз, mac-job довантажує DMG (паттерн уже є у wizard).

## 5. Фази реалізації (інкрементально)
- **Ф.1 Scaffold:** Electron+Vite+TS кістяк (main/preload/renderer/shared), tsconfig-и, electron-builder `build`, dev-запуск (`electron .` + Vite). Порожнє вікно рендериться.
- **Ф.2 Бекенд у main:** перенести `github.ts`/`state.ts`/`types.ts`/`config.ts(gh)`; поллер-таймер; IPC `pull-requests`/`get-config`/`mark-seen`; події `snapshot`/`config-error`. Перевірка через тимчасовий лог.
- **Ф.3 Renderer:** порт `page.tsx`→`App.tsx`, компоненти, `format.ts`; fetch/EventSource → `window.api.invoke`/`window.api.on`. Tailwind v4 у Vite. Дашборд показує реальні PR-и (твій `gh`).
- **Ф.4 Settings UI:** hosts/repos/interval у `userData/settings.json` + детект/гайд для `gh`.
- **Ф.5 Пакування+підпис:** electron-builder dmg/nsis, адаптувати `release-mac.sh`, entitlements.
- **Ф.6 Автооновлення:** electron-updater + publish-конфіг + CI-воркфлоу; тест end-to-end (vX→vX+1).
- **Ф.7 Верифікація:** запуск на mac (і win), реальні дані, автооновлення з релізу.

## 6. Відкриті рішення
- [ ] Назва/appId/productName (напр. «PR Dashboard», `com.creatio.prdashboard`).
- [ ] Фід оновлень: публічні GitHub Releases vs приватні (токен) vs внутрішня шара.
- [ ] Доля наявного Next-коду в репо: лишити на `main` як localhost-варіант чи прибрати після переходу.
- [ ] Tray-іконка/автозапуск при логіні — треба?
- [ ] Windows code-signing cert — є чи лишаємо unsigned (SmartScreen) для v1?
