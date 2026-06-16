# PR Dashboard

A personal dashboard for pull requests across **GitHub** and **GitHub Enterprise** in one place.
It shows an always-current list of PRs where you're involved (author or requested reviewer) and highlights what needs attention:

- ✗ **failing CI** — individual named checks (unit tests, Sonar, etc.) are shown by name;
- ✦ **new comments** — comments added since the last time you viewed the PR;
- 💬 **unresolved comments** — how many threads still need to be resolved;
- review state (approved / changes requested / review required), drafts, author, last update.

**Multi-user**: each person signs in via **OAuth** (GitHub and/or GHE) and sees their own pull requests. Access tokens live in an encrypted session cookie — never in `config.json`, never in the browser.

## Tech stack

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS v4 · GitHub GraphQL API.

## How it works

- One GraphQL request per host per refresh (`author:@me` + `review-requested:@me` + any `team-review-requested:` searches, merged via aliases). Cheap on rate limit (~1 point on GHE).
- Each user authenticates via **OAuth Authorization Code** (web-redirect — credentials are entered on github.com / the GHE tenant, never here). Their tokens are held in an **encrypted (JWE) session cookie** and used only server-side; the browser never sees them.
- The "already seen" state lives in `data/state.json` (gitignored), namespaced per session, so new-comment detection survives reloads.
- A **per-user server-side poller** queries GitHub every `pollIntervalSeconds` using that session's tokens. Each open tab subscribes to a **Server-Sent Events** stream (`/api/stream`) on its own channel and receives updates the moment the poller sees a real change — no client-side polling, no manual refresh. EventSource auto-reconnects on transient drops; a focus/visibility wake-up triggers a one-shot fetch as a safety net after laptop sleep.

## Setup

1. Copy the config template:

   ```bash
   cp config.example.json config.json
   ```

2. Edit `config.json` — list the hosts, their repositories and which OAuth provider authenticates each. `config.json` holds **no credentials**; tokens come from each user's login.

   ```jsonc
   {
     "pollIntervalSeconds": 60,
     "hosts": [
       {
         "label": "GitHub",
         "graphqlUrl": "https://api.github.com/graphql",
         "oauthProvider": "github",
         "repos": ["owner/repo-1", "owner/repo-2"]
       },
       {
         "label": "Creatio GHE",
         "graphqlUrl": "https://api.creatio.ghe.com/graphql",
         "oauthProvider": "ghe",
         "repos": ["org/repo-a"]
       }
     ]
   }
   ```

   **Host fields**

   | Field           | Description |
   | --------------- | ----------- |
   | `label`         | Name shown in the UI (host badge and host filter). |
   | `graphqlUrl`    | GraphQL endpoint. github.com → `https://api.github.com/graphql`; GitHub Enterprise Cloud with data residency (`*.ghe.com`) → `https://api.<tenant>.ghe.com/graphql`; GitHub Enterprise Server → `https://<host>/api/graphql`. |
   | `oauthProvider` | Provider id — maps to the `<PREFIX>_OAUTH_*` env vars (e.g. `"github"` → `GITHUB_OAUTH_*`). The OAuth authorize/token endpoints are derived from `graphqlUrl`. |
   | `repos`         | Repositories in `owner/name` form. |

3. **Register an OAuth App** on each host and wire up the environment.

   For each host, register a (classic) OAuth App with the callback
   `https://<your-host>/api/auth/callback/<oauthProvider>` and scopes
   **`repo`** (private PRs) + **`read:org`** (team-requested reviews). On a
   data-residency GHE tenant this must be done by an **enterprise owner**, and
   the server's egress IP must be allow-listed (IdP Conditional Access / IP allow list).

   Then set environment variables (e.g. in `.env.local` for dev):

   | Variable | Purpose |
   | -------- | ------- |
   | `AUTH_SECRET` | Secret used to encrypt session cookies (any long random string). **Required.** |
   | `AUTH_URL` | Public origin for OAuth callbacks, e.g. `https://prdash.creatio`. Required behind a reverse proxy; falls back to the request origin locally. |
   | `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` | Credentials for the `github` provider. |
   | `GHE_OAUTH_CLIENT_ID` / `GHE_OAUTH_CLIENT_SECRET` | Credentials for the `ghe` provider. |
   | `<PREFIX>_OAUTH_SCOPES` | Optional; overrides the default `repo read:org`. |

   ```bash
   cat > .env.local <<'ENV'
   AUTH_SECRET=$(openssl rand -hex 32)
   AUTH_URL=http://localhost:3737
   GITHUB_OAUTH_CLIENT_ID=...
   GITHUB_OAUTH_CLIENT_SECRET=...
   ENV
   ```

## Run

```bash
npm install   # already done when the project was created
npm run dev    # http://localhost:3737
```

For production mode:

```bash
npm run build
npm start
```

## Run as a background service (always-on, survives reboots)

On macOS, install the dashboard as a `launchd` LaunchAgent so it runs in the
background, starts automatically at login (i.e. after a reboot), and restarts
itself if it ever crashes:

```bash
npm run build               # production build (required by `next start`)
./scripts/install-service.sh
```

It then serves http://localhost:3737 in production mode (`RunAtLoad` +
`KeepAlive`). Management:

```bash
./scripts/redeploy.sh        # after code changes: rebuild + restart
./scripts/uninstall-service.sh   # stop and remove the service

# status / logs
launchctl print gui/$(id -u)/com.akravchuk.github-pr-manager | grep state
tail -f ~/Library/Logs/github-pr-manager.err.log
```

Notes:
- The service starts at **login**, not at the boot screen — open your laptop,
  log in, and the dashboard is already running.

### Windows (WinSW behind IIS)

On a shared Windows server the dashboard runs as a [WinSW](https://github.com/winsw/winsw)
service bound to `127.0.0.1:3737`, with **IIS + URL Rewrite + ARR** terminating
TLS on 443 and reverse-proxying to it. Unlike the macOS LaunchAgent, the service
starts at **boot** (not login).

Prerequisites: Node on the machine PATH; IIS with **URL Rewrite** and **ARR**
(enable ARR proxy mode); a DNS name + TLS cert bound in IIS; a domain **gMSA**
service account; the OAuth secrets set as **machine** environment variables
(so they're never on disk):

```powershell
[Environment]::SetEnvironmentVariable('AUTH_SECRET', '<random>', 'Machine')
[Environment]::SetEnvironmentVariable('GITHUB_OAUTH_CLIENT_ID', '...', 'Machine')
[Environment]::SetEnvironmentVariable('GITHUB_OAUTH_CLIENT_SECRET', '...', 'Machine')
```

Install (elevated PowerShell):

```powershell
.\scripts\install-service.ps1 `
  -WinSWPath C:\tools\WinSW-x64.exe `
  -ServiceAccount 'CONTOSO\prdash$' `
  -AuthUrl 'https://prdash.creatio'
```

This builds the app, deploys `service\prdash.{exe,xml}`, and (idempotently)
installs + starts the service. Then drop [`web.config`](web.config) at the IIS
site root for the reverse-proxy rule. Management:

```powershell
.\scripts\redeploy.ps1            # after code changes: rebuild + restart
.\scripts\uninstall-service.ps1   # stop and remove
Get-Service github-pr-manager
```

**ARR + SSE — server-wide settings** (not in `web.config`): set ARR *Response
buffer threshold* to `0`, raise the proxy *timeout* above the 25 s SSE heartbeat
(e.g. `appcmd set config -section:system.webServer/proxy /timeout:"00:10:00"
/commit:apphost`), and keep the site's app pool at **one worker** (the poller,
broadcast and seen-state are per-process). Open 443 inbound; keep 3737 closed.

## Structure

```
src/
  app/
    page.tsx                  # dashboard (client): SSE subscription, filters, 401→/login, logout
    login/page.tsx            # login screen: per-host "Connect" buttons
    layout.tsx                # dark theme
    api/
      pull-requests/route.ts  # GET — seeds the poller with session tokens, returns snapshot
      stream/route.ts         # GET — per-session Server-Sent Events live updates
      seen/route.ts           # POST — mark a PR as seen
      config/route.ts         # GET — sanitized config (no tokens)
      auth/
        login/[provider]/     # GET — start OAuth (CSRF state + redirect to authorize)
        callback/[provider]/  # GET — exchange code, fetch viewer, write session
        logout/               # POST — clear session + stop the session's poller
  components/
    PrCard.tsx                # PR card
    CheckBadge.tsx            # CI check badge
  lib/
    session.ts                # encrypted (JWE) session cookie
    oauth.ts                  # OAuth provider resolution (endpoints from graphqlUrl, env creds)
    config.ts                 # loads config.json (hosts/repos + oauthProvider; no credentials)
    github.ts                 # GraphQL query and mapping; teamCache keyed per token
    state.ts                  # data/state.json — "seen" state, namespaced per session
    poller.ts                 # per-user server-side pollers (Map<sid>), request-seeded tokens
    broadcast.ts              # in-memory pub/sub, per-session channels
    types.ts                  # domain types
    format.ts                 # client-side helpers
config.example.json           # config template (config.json is gitignored)
web.config                    # IIS reverse-proxy rule + SSE tuning (Windows)
scripts/                      # *.sh (macOS launchd) · *.ps1 + prdash.xml (Windows WinSW)
```

## Notes

- Multiple `repo:` qualifiers in a single GitHub search act as OR — so one request covers all of a host's repositories.
- Checks are deduplicated by name; on re-runs, the worst state wins.
- The first time a PR appears, its current state is recorded as a baseline — so you don't get a "forest" of NEW badges on the first run.
- "New comments" is based on the comment count, not on any update — pushing your own commit or changing labels does not flag a PR.
