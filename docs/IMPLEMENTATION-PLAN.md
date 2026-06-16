# План реалізації: OAuth-логін · аналіз GitHub Pages · перенесення на Windows

> **Призначення цього файлу.** Робимо зміни поступово в кількох сесіях. Цей документ —
> єдине джерело правди, яке читається «з нуля»: поточний стан, три цілі, перевірені
> факти (з джерелами), обов'язкові виправлення, порядок робіт і відкриті рішення.
> **Перед роботою:** оновити checkout (`git fetch`, перевірити ahead/behind), перечитати
> розділ «Прогрес», звіритися з фактами в Додатку A перед висновками за кодом.
>
> Створено: 2026-06-16. Підстава: дослідження з веб-верифікацією офіційних доків +
> адверсаріальна перевірка (workflow `pr-dashboard-migration-plan`, 12 агентів).

---

## 0. Прогрес (оновлювати тут)

Легенда: `[ ]` не почато · `[~]` у роботі · `[x]` готово · `[!]` заблоковано (див. «Відкриті рішення»)

### Спільні / дешеві кроки
- [x] **APP-FIX SSE charset** — у `src/app/api/stream/route.ts` змінити `Content-Type`
  `text/event-stream; charset=utf-8` → голий `text/event-stream` (потрібно для ARR; безпечно вже зараз).

### Ціль 1 — OAuth-логін
- [x] Рішення: **Tier B** (multi-user); flow — Authorization Code web-redirect; **Classic OAuth App**.
- [ ] Реєстрація OAuth App на github.com (callback, scopes `repo`+`read:org`) — **зовнішнє, чекає**
- [ ] Реєстрація OAuth App на creatio.ghe.com (enterprise-owner; EMU) + IP allow-list — **чекає іншого owner'а**
- [x] `src/lib/session.ts` — JWE-сесія (`jose` `EncryptJWT/jwtDecrypt`, `dir`+`A256GCM`)
- [x] `src/lib/oauth.ts` — деривація endpoint-ів провайдера, credentials з env, callback URL
- [x] `src/app/api/auth/login/[provider]` + `callback/[provider]` + `logout`
- [x] `src/lib/config.ts` — `token` опційний, `oauthProvider`, `readConfig()` без резолву; `oauthWebBaseFromUrl()` → у `oauth.ts`
- [x] Auth-gate у 4 роутах + `src/app/page.tsx` (401 → `/login`, кнопка Log out)
- [x] `src/app/login/page.tsx` — кнопки Connect per-host
- [x] Tier B: per-user poller (`Map<sid>`) / broadcast (канали per-sid) / state (namespacing per-sid) + `teamCache` per-token

> **Виконано в гілці `feature/oauth-login`** (build clean, typecheck clean, pure-logic тести pass): крипто-фундамент,
> OAuth web-redirect flow, per-user re-архітектура трьох singleton-ів, gate. **Не виконано (зовнішні блокери):**
> реєстрація OAuth App'ів (немає `*_OAUTH_CLIENT_ID/SECRET`) → end-to-end логін поки неможливо протестити.
>
> **Потрібні env-змінні (рантайм):** `AUTH_SECRET` (ключ шифрування сесії), `AUTH_URL` (публічний origin для callback,
> обов'язково за ARR), `GITHUB_OAUTH_CLIENT_ID`/`GITHUB_OAUTH_CLIENT_SECRET`, (пізніше) `GHE_OAUTH_CLIENT_ID`/`_SECRET`,
> опційно `*_OAUTH_SCOPES`. `config.json`: `token` більше не credential — замість нього `oauthProvider` (`"github"`/`"ghe"`).
>
> **Хардненг (зроблено):** 401 від GitHub (revoke/expire) → хост позначається `disconnected`, токен викидається з поллера (`deadTokens`,
> без повторного hammering), UI показує «Reconnect →»; reconnect із новим токеном автоматично знімає dead-стан (пункт 7).
> seen-state ключується за **стабільною ідентичністю** (`sessionUserKey`: github-login, fallback на `sid`) → NEW переживає logout/login.
> Logout зупиняє поллер сесії (пункт 6).
>
> **Свідомо відкладено:** per-host cookies (пункт 8) — не потрібні поки активний один провайдер (github.com): merge-гонки немає,
> до 4KB-стелі далеко. Робити при вмиканні GHE. `loadConfig`/`resolveToken` лишились як dead-code для можливого PAT-мосту.

### Ціль 2 — GitHub Pages
- [x] Проаналізовано → **неможливо** (див. розділ 3). Дій з реалізації немає.

### Ціль 3 — Windows `ts1-core-dev04`
> **⚠️ Знахідка 2026-06-16 (SSH-доступ є):** `ts1-core-dev04` — **спільний** сервер з чужими workload-ами:
> 7 `node`-процесів + IIS-сайти `Default Web Site`, **`AutoTest` (вже на `*:443:ts1-core-dev04.tscrm.com`)**,
> `Maintainer`(81), `Diagnostics`(82), FTP. Наслідки: (1) **потрібен окремий DNS-хост** (не `ts1-core-dev04.tscrm.com` —
> 443 зайнято; новий сайт — host-header/SNI на 443 коексистує з AutoTest); (2) **enable ARR proxy — серверний global toggle**,
> зачіпає всі сайти → робити лише з явним дозволом, обережно. Решта (новий сайт/біндинг/служба) — ізольовано.
- [x] Ф.0 Передумови — на сервері вже є **Node 24.14.1**, git 2.52, IIS; код у `C:\apps\github-pr-manager`,
  `npm ci` + `npm run build` зелені; **застосунок підтверджено запускається** (smoke на 127.0.0.1:3737:
  `/login`+кнопка, gate 401, OAuth-redirect 307). gMSA — ще ні.
- [x] **DEPLOYED & LIVE (2026-06-16):** обрано спрощену модель — **прямий HTTP на `:3737` без IIS/ARR/TLS**
  (спільний сервер, AutoTest на 443). Служба WinSW `github-pr-manager` встановлена під `NT AUTHORITY\NetworkService`
  (інтерим; gMSA заблоковано — `New-ADServiceAccount` Access denied, треба домен-адмін), Running, boot-старт,
  firewall 3737 in. Підтверджено зовні: `http://ts1-core-dev04.tscrm.com:3737/login`=200, gate=401,
  OAuth-redirect→github.com з реальним client_id. OAuth App на github.com створено (`Ov23liWW702ad31zKnx1`).
- [ ] ~~Ф.1 IIS/ARR/TLS~~ — **не застосовується** в спрощеній моделі (лишається опцією для https/власного хоста)
- [x] Ф.2 Reverse proxy + SSE-тюнінг — `web.config` (rule + compression off); charset-fix зроблено;
  buffer=0/timeout — серверні ARR-налаштування, задокументовано в README/`web.config`
- [x] Ф.3 Служба WinSW — `scripts/prdash.xml` (Automatic, onfailure restart, roll-логи, gMSA, env)
- [x] Ф.4 Токени/секрети — OAuth (Ц.1) + секрети через **machine env** (не на диску); PAT-міст не потрібен
- [~] Ф.5 persistence/бекап/firewall — політика задокументована (443 in, 3737 closed, 1 worker); застосування — **сервер-опс**
- [x] Ф.6 PowerShell: `install-service.ps1` / `redeploy.ps1` / `uninstall-service.ps1` (WinSW-ідемпотентність)
- [ ] Ф.7 Верифікація (reboot-старт, авто-рестарт, SSE end-to-end, OAuth-callback) — **сервер-опс**

---

## 1. Головний висновок

| Ціль | Вердикт | Суть |
|---|---|---|
| **1. OAuth-логін** (github.com + creatio.ghe.com) | Реалізовно, з застереженнями | Власна реалізація Authorization Code, **не** NextAuth. Рівні: A (gate) / B (multi-user). |
| **2. GitHub Pages** | **Неможливо** | Лише статика: білд із `output:'export'` падає; немає де крутити poller/SSE/секрети/стан. |
| **3. Windows `ts1-core-dev04`** | Реалізовно, рекомендовано | `next start` як служба **WinSW** за **IIS + ARR** (HTTPS + стабільний хост для callback). |

**Зв'язок цілей (критично):** спільний сервер робить теперішню модель «без авторизації»
(будь-хто за URL бачить PR власника токена) неприйнятною → **OAuth (Ц.1) фактично
обов'язковий** перед виставленням на `ts1-core-dev04`. OAuth потребує стабільного
**HTTPS-хоста для callback**, який дає саме перенесення (Ц.3). Тобто **Ц.1 і Ц.3 ідуть разом**,
а Ц.2 відпадає.

---

## 2. Поточний стан (baseline)

- **Жодної автентифікації.** Токени резолвляться лише на сервері (`src/lib/config.ts`)
  з `gh` CLI / `env:` / літерала і **ніколи не потрапляють у браузер** — навмисна
  властивість безпеки.
- **Singleton-поллер** (`src/lib/poller.ts`, self-rescheduling `setTimeout` на `globalThis`)
  + **in-memory SSE** (`src/lib/broadcast.ts`, `src/app/api/stream/route.ts`)
  + **глобальний файловий стан** (`src/lib/state.ts`, `data/state.json`).
  Усе **single-process, single-identity**.
- **Шлях fetch** (`src/lib/github.ts`) трактує `host.token` як прозорий Bearer і для GraphQL,
  і для REST `/user/teams` → OAuth-токен це **drop-in**, змінюється лише джерело токена.
- **Деплой:** macOS `launchd` LaunchAgent (`scripts/install-service.sh`), `next start -p 3737`
  на localhost, старт **при логіні** (не при завантаженні), токен — з `gh` CLI.
- `next.config.ts` **чистий** (без `output:'export'`); дерево clean (перевірено 2026-06-16).

### Карта файлів
```
src/app/page.tsx                 # клієнт: SSE-підписка, фільтри (436 рядків)
src/app/login/page.tsx           # (НОВИЙ) сторінка логіну
src/app/api/
  pull-requests/route.ts         # GET — кеш поллера; чекає awaitFirstTick()
  stream/route.ts                # GET — SSE (рядок ~115: Content-Type для app-fix)
  seen/route.ts                  # POST — mark seen (POST не підтримує static export)
  config/route.ts                # GET — публічний конфіг без токенів
  api/auth/{login,callback,logout}  # (НОВІ) OAuth-роути
src/lib/
  config.ts                      # резолв токенів (буде переписано)
  github.ts                      # GraphQL + /user/teams; teamCache (рядок ~370)
  state.ts                       # data/state.json (validate token при рядку ~107)
  poller.ts                      # singleton; tick() без request-контексту
  broadcast.ts                   # in-memory Set pub/sub
  session.ts                     # (НОВИЙ) JWE-сесія
  types.ts                       # доменні типи
scripts/                         # *.sh (macOS) → додати *.ps1 + prdash.xml (Windows)
```

---

## 3. Ціль 2 — GitHub Pages: чому неможливо (закрито)

Pages — суто статичний хостинг (HTML/CSS/JS), **без серверного коду, секретів у рантаймі,
довгоживучого процесу, термінації SSE, запису у ФС** (офіційні доки).

1. **Білд не збирається.** З `output:'export'` `next build` (Next 16.2.6) падає на збиранні
   page-data через `force-dynamic` на API-роуті (`/api/stream` або `/api/config` —
   порядок недетермінований серед воркерів).
2. **Нуль серверного коду** → ніде крутити поллер, in-memory SSE, `execFileSync('gh')`,
   `readFileSync(config.json)`, запис `data/state.json`.
3. **Роути несумісні:** static export — лише `GET`; `/api/seen` — `POST`. `/api/stream` — стрім.
4. **Секрети неможливі:** OAuth `client_secret` **обов'язковий** на обміні коду (PKCE не скасовує).
   Це вбиває Ц.1 на Pages і ламає «токени не доходять до браузера».

**CORS — НЕ блокер** (поширений міф): жива перевірка показала `Access-Control-Allow-Origin: *`
на `api.github.com/graphql` і edge `*.ghe.com` з дозволеними `Authorization`+`POST`.
Блокери — архітектура й безпека.

**Легітимний варіант (НЕ виконує умову «сервер на Pages»):** Pages віддає статичний фронтенд,
а **окремий бекенд** (той самий `ts1-core-dev04`) тримає секрет/робить token-exchange/крутить
поллер/термінує SSE/проксує API. Callback OAuth тоді вказує на бекенд, не на `github.io`.
Сервер при цьому **поза Pages** → переходимо до Ц.3.

---

## 4. Ціль 1 — OAuth-логін (github.com + creatio.ghe.com)

### 4.1 Рекомендація: власна реалізація, НЕ NextAuth
Жорстка вимога — один користувач одночасно залогінений у **обидва** хости, сервер тримає
**обидва** токени водночас. NextAuth v5 цього нативно не вміє (сесія = один провайдер;
другий логін перетирає перший; account-linking потребує БД-адаптера + Account-таблиці +
кастомних callback-ів). Застосунок має нуль auth/DB-залежностей → NextAuth нав'язав би БД
і все одно більшість ручної роботи. Шлях fetch уже працює з прозорим Bearer.

### 4.2 Два рівні
- **Tier A — мінімальний (рекоменд. для v1, ~1.5–2.5 дня коду).** Логін як gate + джерело
  токена для наявного single-identity застосунку. Поллер структурно лишається.
  Обмеження: якщо залогіняться двоє різних людей — спільний поллер/SSE/seen-state,
  видно ідентичність **останнього** логіну. Прийнятно для персонального деплою.
- **Tier B — повний multi-user (+3–5 днів).** Переархітектура трьох singleton-ів:
  поллер → `Map` per-user; broadcast → канали per-user; `state.json` → namespacing per-user;
  per-user rate-limit budgeting; per-user `teamCache`.

### 4.3 Реєстрація OAuth-застосунків (зовнішня залежність, довгий хвіст)
- **github.com:** OAuth App, callback `https://<хост>/api/auth/callback/github`,
  scopes `repo` + `read:org` (для `/user/teams` → `team-review-requested`).
- **creatio.ghe.com:** ендпоінти на **tenant web host**, не на `api.`:
  - authorize: `https://creatio.ghe.com/login/oauth/authorize`
  - token: `https://creatio.ghe.com/login/oauth/access_token`
  - виводити, відрізаючи провідний `api.` від `graphqlUrl` (`api.creatio.ghe.com` → `creatio.ghe.com`);
    **не** використовувати `auth.ghe.com` (це лише IdP-вхід).

> **Жорсткі обмеження GHE (підтверджено доками — див. Додаток A):**
> - **EMU-only** → OAuth App мусить зареєструвати/схвалити **enterprise-owner**
>   (керований користувач не авторизує сторонній застосунок сам).
> - **IdP Conditional Access Policy / IP allow list:** GitHub валідує **egress-IP сервера**
>   на кожен OAuth-запит → статичний IP `ts1-core-dev04` треба внести в allow-list / зробити виняток.
> - Tenant може бути доступний лише з корпоративної мережі/VPN (і для сервера, і для браузера
>   на кроці authorize).

### 4.4 ОБОВ'ЯЗКОВІ виправлення (з адверсаріальної перевірки)
1. **JWE, а не JWS.** Cookie з токенами — `jose` `EncryptJWT/jwtDecrypt` (напр. `dir`+`A256GCM`).
   `SignJWT/HS256` лише підписує → токени читані в base64url (порушує «opaque if exfiltrated»).
2. **SSE не бере участь у 401-gate як звичайний роут.** Браузерний `EventSource`
   (`src/app/page.tsx`) не читає статус/тіло 401 → нескінченний reconnect. Gate вести через
   звичайні `fetch` (`/api/config`, `/api/pull-requests`); `/api/stream` лише **закриває
   з'єднання** серверно. Cookie на SSE-відповіді **не оновлюється** (Next 16: не можна ставити
   cookie після початку стріму).
3. **Tier A — постачання токена request-seeded.** `tick()` працює на таймері без
   request-контексту → не може викликати `getSession()`. Автентифікований `/api/pull-requests`
   (має cookies) кладе токени в `globalThis`-слот і **лише тоді** викликає `ensurePollerStarted()`.
   Порожній слот → стан «увійдіть», не config-error. Звірити, що `awaitFirstTick()` не зависає
   у no-identity випадку.
4. **`validate()` нині кидає помилку без `token`** (`src/lib/config.ts`, ~рядок 107) — послабити.
5. **`teamCache`** (`src/lib/github.ts`, ~рядок 370) ключований за `graphqlUrl` → у multi-identity
   віддасть чужі команди. Зробити per-token (обов'язково для Tier B).
6. **Logout чистить слот ідентичності поллера** (інакше застарілі токени далі поллять;
   ідеально — зупиняти таймер, коли ідентичностей не лишилось).
7. **Обробка 401 від GitHub** (revoke/expire) → позначити хост «disconnected», очистити токен.
   Класичний OAuth App (нестроковий токен) для v1 простіший за GitHub App (8 год + refresh + per-org).
8. **Стеля cookie ~4KB:** два токени + JWE-обгортка близько до межі; payload мінімальний
   (без `avatarUrl` — тягнути на клієнті). За потреби — **per-host cookies** (заодно прибирає
   гонку «merge у callback» при паралельних логінах).
9. **PKCE — опційний** для confidential-клієнта (секрет уже є); реальний CSRF-захист — `state`.
10. **Viewer-fetch у callback** (`viewer { login avatarUrl }` або REST `/user`) — проти **правильного**
    API-хоста; на GHE він теж підлягає CAP/IP-allow-list → graceful degrade (зберегти токен,
    лейбл пізніше), бо це ранній сигнал, що IP сервера не allow-listed.
11. **CSRF на POST-роутах** (`/api/seen`, `/api/auth/logout`) після переходу на ambient cookie:
    `sameSite=lax` допомагає, але розглянути CSRF-токен для in-app POST.

### 4.5 Файли
**Нові:** `src/lib/session.ts`, `src/app/api/auth/login/[provider]/route.ts`,
`src/app/api/auth/callback/[provider]/route.ts`, `src/app/api/auth/logout/route.ts`,
`src/app/login/page.tsx`.
**Змінити:** `src/lib/config.ts` (прибрати `gh`/PAT, `oauthWebBaseFromUrl()`, послабити `validate()`),
усі 4 роути (gate), `src/app/page.tsx` (401→/login, per-host «Connect», logout/avatar),
`src/lib/types.ts` (`oauthProvider` у `HostConfig`, `SessionPayload`),
`config.json`/`config.example.json` (token більше не credential; додати `oauthProvider`),
`package.json` (+`jose`, без NextAuth).
**Tier B додатково:** `src/lib/poller.ts` (`Map` per-user), `src/lib/broadcast.ts` (канали per-user),
`src/lib/state.ts` (namespacing per-user).

---

## 5. Ціль 3 — Windows `ts1-core-dev04`

### 5.1 Модель
**WinSW** запускає `node node_modules\next\dist\bin\next start -p 3737` як **одну** службу,
прив'язану до `127.0.0.1:3737`, за **IIS + URL Rewrite + ARR** (TLS + стабільний хост для callback).

Чому не інші: **NSSM** — реліз 2017, без зручних env/onfailure/log. **PM2** — без нативного
boot-старту на Windows (усе одно WinSW), cluster тут **шкідливий** (per-process singleton-и).
**iisnode** — мертвий. **Task Scheduler** — без авто-рестарту на крах.

### 5.2 Фази
- **Ф.0 Передумови.** Зафіксувати Node LTS (локально v26, `@types/node ^20` — обрати/записати,
  напр. **Node 22 LTS**); Git; clone у `C:\apps\github-pr-manager`; `npm ci && npm run build`.
  Сервіс-акаунт low-priv (краще **gMSA** — без пароля у файлі), право «Log on as a service»,
  запис у `data\`. `gh` CLI на сервері **не потрібен** (boot-служба не має інтерактивної `gh`-сесії).
  **Перед білдом пересвідчитись**, що `next build` показує **4 динамічні API-роути**, а не «1 static»
  (тобто `next.config.ts` без `output:'export'` — наразі так і є).
- **Ф.1 Хост + HTTPS (до реєстрації OAuth).** Стабільний DNS (напр. `prdash.creatio` →
  `ts1-core-dev04`); встановити **URL Rewrite + ARR** (не стоять за замовч.), увімкнути proxy-режим;
  прив'язати TLS-сертифікат (внутрішній CA або win-acme). Цей фіксований `https://…` —
  передумова для callback **обох** OAuth-застосунків (змінювати потім = редагувати обидві реєстрації).
- **Ф.2 Reverse proxy + SSE-тюнінг.** Inbound-правило на `http://127.0.0.1:3737/{R:1}` з `X-Forwarded-*`.
  **SSE крізь ARR — 4 не-дефолтні правки:**
  1. **APP-FIX:** `src/app/api/stream/route.ts` (~рядок 115) `text/event-stream; charset=utf-8`
     → голий `text/event-stream` (ARR не стрімить із charset; `EventSource` під'єднається, але
     даних не буде). `utf-8` — дефолт спеки.
  2. ARR **Response buffer threshold = 0** (server-wide).
  3. Вимкнути dynamic+static compression на `/api/stream` (`<location path="api/stream">`).
  4. Підняти **ARR proxy timeout** (деф. 30 с) вище 25-с heartbeat, напр. 10 хв
     (`appcmd set config -section:system.webServer/proxy /timeout:"00:10:00" /commit:apphost`).
  - Наявні `X-Accel-Buffering: no` / `Cache-Control: no-cache, no-transform` — nginx-хінти,
    під IIS безпечні no-op, лишити.
- **Ф.3 Служба WinSW** (заміна `launchd`). `prdash.xml`:
  `<executable>node.exe</executable>`, `<arguments>node_modules\next\dist\bin\next start -p 3737</arguments>`,
  `<workingdirectory>C:\apps\github-pr-manager</workingdirectory>`,
  `<startmode>Automatic</startmode>` (**при завантаженні**, на відміну від login-старту launchd),
  `<onfailure action="restart" delay="10 sec"/>` (= KeepAlive),
  `<log mode="roll"/>` (краще roll-by-size + keepFiles — обмежити диск),
  `<serviceaccount>` (gMSA),
  env: `NODE_ENV=production`, `PORT=3737`, далі `AUTH_SECRET`, `*_OAUTH_CLIENT_ID/SECRET`,
  і **`AUTH_TRUST_HOST=true` / `AUTH_URL=https://prdash.creatio`** (інакше Next згенерує callback
  на `127.0.0.1:3737`). XML захистити NTFS-ACL (секрети у відкритому вигляді) або винести в
  machine env / DPAPI / Credential Manager. node = дочірній процес служби (як `exec` у `serve.sh`).
- **Ф.4 Токени/секрети на спільному сервері.** Стара gh-модель ламається. Мігрувати на per-user
  OAuth (Ц.1). **Перехідний міст** до готовності OAuth: `config.json` → `env:GH_TOKEN_GITHUB` /
  `env:GH_TOKEN_GHE` (PAT із scopes **`repo`+`read:org`** — інакше тихо ламається team-review),
  інжектовані через WinSW env, **лише за внутрішнім firewall**.
- **Ф.5 Стан, бекап, firewall.** `data\state.json` під сервіс-акаунтом (або фіксований
  `C:\apps\github-pr-manager\data`); бекап — **атомарний запис tmp+rename** безпечніший за VSS
  під час `writeFile`. Відкрити **443** inbound, **3737 не виставляти** (loopback bind).
  App-pool сайту — **один worker**, без web gardens (інваріант одного процесу).
- **Ф.6 PowerShell-аналоги** (`scripts/`): `install-service.ps1` (npm ci/build → записати `prdash.xml`
  → `winsw install` → `winsw start`), `redeploy.ps1` (`npm run build` → `winsw restart`),
  `uninstall-service.ps1` (`winsw stop; winsw uninstall`). **Ідемпотентність WinSW-специфічна:**
  `winsw status`; якщо є — `stop`+`uninstall`, чекати, поки SCM реально прибере службу
  (poll `Get-Service` до відсутності), потім `install`. Врахувати стан «marked for deletion»
  (закрити відкритий `services.msc`). **Не** копіювати launchd bootout-retry — це інша модель.
- **Ф.7 Верифікація.** Старт **після reboot** (не лише re-login); авто-рестарт після kill PID
  (звільнення 3737, без orphan/EADDRINUSE; на Windows немає SIGTERM); HTTPS через хост;
  **SSE end-to-end крізь ARR** (gate — charset-fix); OAuth-callback генерується на публічний origin;
  rolling-логи; 3737 ззовні недоступний. Loopback: Next слухає **IPv4 `127.0.0.1`** — ціль rewrite
  має збігатися (пастка `::1` vs `127.0.0.1`).

### 5.3 Файли
**App-fix:** `src/app/api/stream/route.ts` (charset).
**Нові:** `scripts/install-service.ps1`, `scripts/redeploy.ps1`, `scripts/uninstall-service.ps1`,
`scripts/prdash.xml`, `web.config` (reverse-proxy rule + urlCompression off на SSE).
**Змінити:** `config.json` (перехідні `env:GH_TOKEN_*`, потім → OAuth), `README.md` (секція Windows).

---

## 6. Рекомендована послідовність

1. **Рішення/доступи** (паралельно, довгий хвіст): підтвердити `ts1-core-dev04` як ціль,
   статичний egress-IP, DNS+TLS-хост; знайти enterprise-owner GHE; обрати Node LTS; Tier A чи B.
2. **APP-FIX SSE charset** — дешево й безпечно зараз.
3. **Перенесення на Windows без OAuth** (Ф.0–3,5–7) з перехідним PAT-мостом за firewall —
   **~1–2 дні**. macOS-інстанс лишається джерелом правди до зеленого SSE (паралельний cutover).
4. **OAuth Tier A** (+ виправлення 4.4) — **~1.5–2.5 дня коду** + зовнішній час на GHE-схвалення.
5. (За потреби) **Tier B multi-user** — +3–5 днів.

Повний зв'язаний обсяг реалістично **~1–2 тижні end-to-end**; довгий хвіст — **enterprise-сторона GHE**, не код.

---

## 7. Відкриті рішення (блокери-залежності)

- [x] **Tier A чи B** → **Tier B** (multi-user: poller/broadcast/state per-user).
- [ ] **Enterprise-owner `creatio.ghe.com`:** хто зареєструє/схвалить OAuth App і внесе IP
  `ts1-core-dev04` в IdP CAP / IP allow-list? → потрібна інша людина (довгий хвіст).
  Код реалізуємо так, щоб GHE-провайдер додавався незалежно від github.com.
- [ ] **Мережа GHE:** чи доступний `creatio.ghe.com` із `ts1-core-dev04` **і** з браузерів
  користувачів (VPN/корпмережа)? Чи **статичний** egress-IP у сервера?
- [x] **HTTPS-хост** → IIS на `ts1-core-dev04` (Ф.1 треба виконати перед реєстрацією OAuth Apps).
- [x] **Класичний OAuth App** (нестроковий токен, широкий `repo`) — обрано для v1
  (простіше за GitHub App: без 8-год expiry/refresh/per-org install).
- [x] **Flow:** Authorization Code **web-redirect** (як логін у Claude), **не** Device Flow.
  Логін-пароль вводиться на боці GitHub/GHE, ніколи в нашому застосунку.
- [x] **Node** на `ts1-core-dev04` → **24.14.1**.
- [x] `ts1-core-dev04` **domain-joined** → так, можна використовувати **gMSA**.

---

## Додаток A — Перевірені факти й джерела

### A.1 GitHub OAuth (github.com)
- `client_secret` **обов'язковий** на token-exchange для OAuth Apps і GitHub Apps; PKCE (S256)
  підтримується, але **не скасовує** секрет → статичний SPA не може робити web-flow безпечно.
- Єдиний no-secret шлях — **Device Flow** (копіювати код, без авто-redirect).
- Scopes: `repo` (приватні PR), `read:org` (команди через `/user/teams`).
- Класичний OAuth App: токен **не протухає**. GitHub App: user-токен 8 год + refresh 6 міс,
  fine-grained permissions, per-org install.
- Redirect host/port мусять збігатися з реєстрацією; HTTPS не строго обов'язковий; loopback
  `127.0.0.1` дозволений, але не hostname `localhost`.
- Джерела: docs.github.com — Authorizing OAuth apps; Best practices; Scopes; Generating/Refreshing
  user access token (GitHub App).

### A.2 GHE Cloud data residency (`creatio.ghe.com`)
- Ендпоінти на subdomain: web/OAuth на `creatio.ghe.com`, API на `api.creatio.ghe.com` (REST + `/graphql`).
- `auth.ghe.com` — спільний IdP-вхід, **не** база для OAuth authorize/token.
- **EMU-only** (обов'язково): керовані користувачі **не** ставлять non-privileged GitHub Apps →
  потрібен enterprise-owner для реєстрації/схвалення.
- **IdP CAP:** валідує **IP сервера застосунку** на OAuth-запитах → IP `ts1-core-dev04` allow-list/exempt.
- **Enterprise IP allow list:** покриває OAuth/GitHub-App user-to-server токени.
- Tenant прив'язаний до регіональних IP-діапазонів; зовнішня доступність не гарантована.
- Вартість запиту (project memory): дашборд-GraphQL ~1 пункт на GHE vs ~35 на github.com.
- Джерела: docs.github.com/enterprise-cloud — data residency (about/feature-overview/network-details);
  Authorizing OAuth apps; Abilities/restrictions of managed user accounts; IdP Conditional Access Policy;
  IP allow list; Enterprise Managed Users.

### A.3 GitHub Pages
- Чиста статика; «does not support server-side languages». Не тримає секрет, не виконує код.
- `output:'export'` + `next build` (Next 16.2.6) **падає** на page-data через `force-dynamic`
  (роут недетермінований серед воркерів). Перевірено емпірично.
- Локальні доки Next 16: static export — лише `GET`, не можна читати динамічні значення запиту;
  Route Handlers з `Request`, cookies, Server Actions тощо не підтримуються.
- «To run Next.js, your platform needs a Node.js server.»
- Джерела: локальні `node_modules/next/dist/docs/...` (static-exports, route-handlers,
  deploying-to-platforms); docs.github.com/pages.

### A.4 CORS (браузер → GitHub GraphQL)
- **НЕ блокер.** Жива перевірка 2026-06-16: `api.github.com/graphql` і edge `*.ghe.com` віддають
  `Access-Control-Allow-Origin: *`, дозволені `Authorization` + `POST`.
- Bearer у звичайному заголовку — **не** «credentialed» запит → wildcard не блокує (але не можна
  `credentials:'include'`).
- Реальний блокер для SPA — **безпека токена в браузері** + потреба бекенда для OAuth-секрету.
- Джерела: docs.github.com REST CORS; MDN CORS; community discussion #3622 (історичний, вирішений).

### A.5 Windows-сервіс + SSE за IIS/ARR
- **WinSW** (підтримуваний, XML) — рекомендований; той самий движок, що генерує node-windows.
  `startmode=Automatic` = boot; `<onfailure restart>`; `<env>`; `<serviceaccount>`; `<log roll>`.
- **iisnode мертвий** — IIS лише як reverse proxy до окремо-керованого Node-процесу.
- **PM2** — без boot-старту на Windows; cluster шкідливий (per-process singleton-и).
- **NSSM** — ок, але 2017; **Task Scheduler** — без авто-рестарту на крах.
- **SSE-пастки:** (1) `Content-Type: text/event-stream` **без** `charset` (інакше ARR не стрімить);
  (2) ARR response buffer threshold = 0; (3) compression off; (4) proxy timeout > 25 с heartbeat.
- **Один процес** обов'язково (поллер/broadcast/seen-state per-process). App-pool 1 worker, без web gardens.
- `next start` за IIS на `127.0.0.1:3737`, ніколи прямо на 443. 443 in, 3737 closed.
- Next за проксі: `trustHost` / `AUTH_URL`, інакше callback-URL = `127.0.0.1:3737`.
- Джерела: WinSW v3 xml-config; iisnode-deprecated / IIS-reverse-proxy guides; PM2-on-Windows;
  PocketBase #3461 (SSE charset); MS Learn (SSE buffering, ARR 502 timeout, response buffer threshold).

### A.6 NextAuth vs hand-rolled
- NextAuth v5 — single-provider session; другий логін перетирає; account-linking потребує
  БД-адаптера + Account-таблиці + кастомних callback-ів.
- Для dual-simultaneous-token + zero-DB → **hand-rolled** Authorization Code, сесія з двома
  зашифрованими токенами.
- Джерела: next-auth discussions #1702, #9480; next-auth FAQ (linking removed since v2);
  next-auth-account-linking.

### A.7 Поправки адверсаріальної перевірки
- Поллер — **self-rescheduling `setTimeout`**, не `setInterval` (architecturally equivalent).
- Білд-помилка static export називає **недетермінований** роут (`/api/stream` або `/api/config`).
- **`next.config.ts` наразі чистий** (без `output:'export'`) — «critical»-претензія верифікатора
  про наявний export **не підтверджена** (перевірено: дерево clean). Дія: лише пересвідчитись,
  що build показує 4 динамічні роути.
- Рядок SSE Content-Type (`text/event-stream; charset=utf-8`) — підтверджено, потребує app-fix.
