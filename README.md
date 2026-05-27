# PR Dashboard

A personal dashboard for pull requests across **GitHub** and **GitHub Enterprise** in one place.
It shows an always-current list of PRs where you're involved (author or requested reviewer) and highlights what needs attention:

- ✗ **failing CI** — individual named checks (unit tests, Sonar, etc.) are shown by name;
- ✦ **new comments** — comments added since the last time you viewed the PR;
- 💬 **unresolved comments** — how many threads still need to be resolved;
- review state (approved / changes requested / review required), drafts, author, last update.

Designed for a **single user**: tokens are stored locally in `config.json` (which is gitignored).

## Tech stack

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS v4 · GitHub GraphQL API.

## How it works

- One GraphQL request per host per refresh (two searches — `author:@me` + `review-requested:@me`, merged via aliases). Cheap on rate limit (~1 point).
- Tokens live **only on the server** (route handlers). They never reach the browser.
- The "already seen" state is stored in `data/state.json` (also gitignored), so new-comment detection survives reloads and switching browsers.
- Data refreshes automatically every `pollIntervalSeconds`, when the tab regains focus, and via the "Refresh" button.

## Setup

1. Copy the config template:

   ```bash
   cp config.example.json config.json
   ```

2. Edit `config.json` — add your hosts, repositories and tokens.

   ```jsonc
   {
     "pollIntervalSeconds": 60,
     "hosts": [
       {
         "label": "GitHub",
         "graphqlUrl": "https://api.github.com/graphql",
         "token": "gh",
         "repos": ["owner/repo-1", "owner/repo-2"]
       },
       {
         "label": "Creatio GHE",
         "graphqlUrl": "https://api.creatio.ghe.com/graphql",
         "token": "gh",
         "repos": ["org/repo-a"]
       }
     ]
   }
   ```

   **Host fields**

   | Field        | Description |
   | ------------ | ----------- |
   | `label`      | Name shown in the UI (host badge and host filter). |
   | `graphqlUrl` | GraphQL endpoint. github.com → `https://api.github.com/graphql`; GitHub Enterprise Cloud with data residency (`*.ghe.com`) → `https://api.<tenant>.ghe.com/graphql`; GitHub Enterprise Server → `https://<host>/api/graphql`. |
   | `token`      | How to obtain the token (see below). |
   | `repos`      | Repositories in `owner/name` form. |

   **Ways to set `token`**

   - `"gh"` — take the token from the [`gh` CLI](https://cli.github.com/). The host is derived from `graphqlUrl`, so it runs `gh auth token --hostname <host>` and works for both github.com and a GHE host you're logged into (`gh auth login --hostname <host>`).
   - `"env:GHE_TOKEN"` — read from an env variable (e.g. from `.env.local`).
   - `"ghp_..."` — put the token inline (a string in `config.json`, which isn't committed).

   The token needs a Personal Access Token with the **`repo` scope** (for private repositories). For GitHub Enterprise, use a token on that host.

3. (Optional) If you use `env:`, create `.env.local`:

   ```bash
   echo 'GHE_TOKEN=your_ghe_token' > .env.local
   ```

## Run

```bash
npm install   # already done when the project was created
npm run dev    # http://localhost:3000
```

For production mode:

```bash
npm run build
npm start
```

## Structure

```
src/
  app/
    page.tsx                  # dashboard (client): polling, filters, grouping
    layout.tsx                # dark theme
    api/
      pull-requests/route.ts  # GET — aggregates PRs across all hosts
      seen/route.ts           # POST — mark a PR as seen
      config/route.ts         # GET — sanitized config (no tokens)
  components/
    PrCard.tsx                # PR card
    CheckBadge.tsx            # CI check badge
  lib/
    config.ts                 # loads config.json + resolves tokens
    github.ts                 # GraphQL query and mapping
    state.ts                  # data/state.json — "seen" state
    types.ts                  # domain types
    format.ts                 # client-side helpers
config.example.json           # config template (config.json is gitignored)
```

## Notes

- Multiple `repo:` qualifiers in a single GitHub search act as OR — so one request covers all of a host's repositories.
- Checks are deduplicated by name; on re-runs, the worst state wins.
- The first time a PR appears, its current state is recorded as a baseline — so you don't get a "forest" of NEW badges on the first run.
- "New comments" is based on the comment count, not on any update — pushing your own commit or changing labels does not flag a PR.
