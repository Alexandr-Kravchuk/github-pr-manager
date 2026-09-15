---
name: prd-release
description: >-
  Cut a new PR Dashboard (github-pr-manager) desktop release end-to-end for Alex:
  macOS (signed + notarized DMG/ZIP) and Windows (NSIS installer, unsigned unless
  built on the corporate host), both
  attached to one GitHub Release with working electron-updater feeds. Triggers ONLY
  inside the Alexandr-Kravchuk/github-pr-manager repository when Alex says "реліз",
  "створи реліз", "новий реліз", "зроби реліз", "release" and wants it shipped (not
  merely discussed). Runs: bump version, commit + push to main, tag, build BOTH
  platforms FROM THE TAG, upload via the scripts (never by hand), verify both update
  feeds, then report. Not for the clio repo — that is clio-release.
---

# Cut a PR Dashboard release

End-to-end release skill for **Alexandr-Kravchuk/github-pr-manager** (the "PR Dashboard"
Electron app). Two platforms, one GitHub Release, two update feeds.

## Scope guard

Confirm with `gh repo view --json nameWithOwner` → must be
`Alexandr-Kravchuk/github-pr-manager`. Any other repo: stop. For clio use `clio-release`.

Release notes and commits are English. The final report to Alex is Ukrainian and short.

## The one mistake that has actually shipped

`scripts/release-mac.sh` builds **whatever working tree you invoke it from**, and derives
the tag purely from `package.json`:

```bash
cd "$(dirname "$0")/.."
VERSION="$(node -p "require('./package.json').version")"; TAG="v$VERSION"
```

It never looks at git. So if the checkout is sitting on some stale feature branch and you
hand-edit `package.json`, you get a DMG **named** `1.13.0` that **contains the wrong
code** — and every downstream check (feed reachable, sha512 matches the local file,
release published) still passes, because they all verify the artifact you built, not
which commit it came from. In v1.13.0 this shipped a macOS build missing the release's
own headline fix.

**Therefore: never build without first proving the tree equals the tag.** The
discriminating check, run in the directory you will build from:

```bash
git diff --stat v<version>        # MUST be empty
```

Empty → safe. Any `src/` file listed → stop and fix the checkout; do not build.

`scripts/release-win.ps1` has the opposite behavior — it does
`git checkout main; git reset --hard origin/main` itself, so it always builds
**origin/main's tip**, ignoring `-Tag`'s content. That's correct only while the tag
IS main's tip. If main has moved on past the tag, Windows would build something newer
than the release — check `git rev-parse origin/main` against the tag before running it.

## Step 0 — Orient

```bash
git fetch --tags
git tag --sort=-v:refname | head -5      # version-sorted, NOT -creatordate
git log --oneline <lastTag>..origin/main
```

- No commits since the last tag → nothing to release; tell Alex and stop.
- Decide the version with Alex (`X.Y.Z`, tags are `vX.Y.Z`). Confirm it's free:
  `git tag -l v<new>` and `git ls-remote --tags origin v<new>` both empty.
- Read the PRs for substance for the notes: `gh pr view <N> --json title,body`.

## Step 1 — Bump on main, tag the bump commit

Version bumps go **straight to main**, no PR (matches `482c19a Release v1.12.0`).
Work in a checkout that is genuinely on main — if `main` is checked out in a worktree,
build there rather than fighting git over it.

```bash
# in the tree that is on main:
# edit package.json "version" -> X.Y.Z
git add package.json && git commit -m "chore: bump version to X.Y.Z"
git fetch origin main                     # re-check for parallel pushes
git push origin main
git tag vX.Y.Z <bump-sha> && git push origin vX.Y.Z
```

The tag must point at the bump commit so `package.json`'s version matches the tag exactly.
Pushing the tag is safe — nothing publishes on tag push.

## Step 2 — Gate before building

In the build tree:

```bash
[[ -n "$(ls -A node_modules 2>/dev/null)" ]] || npm ci   # see below — test CONTENTS, not the directory
git diff --stat vX.Y.Z              # MUST be empty — see the section above
npm run typecheck && npm test
```

Don't skip `npm ci` reasoning, and test the directory's **contents**: a worktree under
`.claude/worktrees/` can hold an EMPTY `node_modules`, so `[[ -d node_modules ]]` passes
while nothing is installed. `npm run typecheck` and `npm test` pass in that state too —
Node walks up and resolves the parent checkout's `node_modules` — so the gate gives no
warning either. The build is where it surfaces, with a message that names neither the
worktree nor the missing install:

```
⨯ Electron version "^35.0.0" is a range, not a fixed version.
⨯ Cannot compute electron version from installed node modules
```

That is electron-builder failing to read `node_modules/electron/package.json`, i.e. the
install is missing — not a `package.json` problem. Run `npm ci` and rebuild; don't pin the
Electron version in response to it. `npm ci` leaves install scripts unapproved
(`npm warn install-scripts`), which is harmless here: electron-builder downloads its own
platform binaries.

## Step 3 — Create the GitHub Release as a DRAFT (notes first, assets after)

```bash
gh release create vX.Y.Z --draft --title "Release X.Y.Z" --notes-file /path/notes.md
```

**`--draft` is mandatory, and publishing happens only in Step 7, after both platforms'
assets are in.** This repo has GitHub's *immutable releases* in effect: the moment a
release is published it is frozen, every asset upload against it returns
`HTTP 422 Cannot upload assets to an immutable release`, and — the part that costs a
version — **its tag name is burned permanently, even after the release is deleted**.
A later `gh release create`/`PATCH` on that tag fails with
`tag_name was used by an immutable release`, so the only way out is to re-cut the whole
release under a new version. That is exactly what turned v1.15.0 into v1.15.1: both
platforms built and notarized fine, and every upload bounced off a release created
without `--draft`.

Both upload scripts resolve the release from the `/releases` LIST by tag (draft-aware) and
upload **by ID**, so creating the draft first keeps mac + Windows on one release with no
duplicate drafts. If it doesn't exist yet, each script creates its own draft — avoid that
race by creating it here.

Notes style: see **Release notes** below.

## Step 4 — macOS build + upload

```bash
source <your-apple-creds.env>              # path is in Alex's personal notes, not this repo
export GH_TOKEN="$(gh auth token)"         # release-mac.sh dies at the upload step without it
npm run release:mac
```

That env file must export `MAC_CERT_P12`, `MAC_CERT_PASSWORD`, `APPLE_API_KEY`,
`APPLE_API_KEY_ID`, `APPLE_API_ISSUER` (all five are hard preconditions — the script
`die`s naming the first one missing) plus `UPLOAD_RELEASE=1`. Missing any of them is the
first thing to check when `release:mac` fails within a second of starting.

Run it in the background — build + notarization takes several minutes.

`release-mac.sh` cleans its own stale artifacts (`dist/*.dmg|*.zip|latest-mac.yml`), so
`rm -rf dist` is unnecessary. Without `GH_TOKEN` it still builds and notarizes, then dies
at upload — that's the failure that led to hand-uploading in v1.13.0. Don't hand-upload;
re-run with the token, or replay just the script's `upload_asset` loop over
`dist/*.dmg dist/*.dmg.blockmap dist/*.zip dist/*.zip.blockmap dist/latest-mac.yml`.

**Never use `gh release upload` for these assets.** Three reasons, all of which bit v1.13.0:
- `gh` renames `PR Dashboard-…` → `PR**.**Dashboard-…` (space→dot), but `latest-mac.yml`
  references dash-names (the script uses `tr ' ' '-'`), so the feed points at a
  nonexistent asset.
- It won't bring `latest-mac.yml`, and **macOS reads `latest-mac.yml`, not `latest.yml`**
  (`latest.yml` is Windows-only). Missing it = updater gets 404 = silently "no updates".
- It won't bring the ZIP, and **Squirrel.Mac updates from the ZIP, not the DMG**.

## Step 5 — Windows build + upload (GitHub Actions, not the SSH host)

The NSIS installer cannot be built on macOS. The route actually used is the repo's
`Release` workflow (`.github/workflows/release.yml`, `workflow_dispatch`), which runs the
test job and then builds + uploads the Windows installer from a `windows-latest` runner:

```bash
gh workflow run release.yml --ref vX.Y.Z      # the TAG, not main — main may move on
gh run list --workflow=release.yml -L 1 --json databaseId,headSha,status,url
gh run watch <runId> --exit-status
```

Pass `--ref vX.Y.Z` and then **check the run's `headSha` equals the tag** — the workflow
otherwise checks out the default branch, which is the same class of wrong-commit build the
`git diff --stat` gate exists to prevent on macOS.

Two consequences of this route, both of which belong in the report to Alex:

- The `.exe` is **not Authenticode-signed**. Signing lives in `scripts/release-win.ps1`,
  which runs `signtool` on the corporate Windows host (`ts1`) and is a separate, heavier
  route: it needs VPN, does its own `git checkout main; git reset --hard origin/main`
  (so it builds origin/main's TIP, correct only while the tag IS the tip), and carries
  PowerShell 5.1 quoting traps — `&&` is not a separator (use `;`), invoke via `-File`,
  `-Token` is mandatory, no `head`/`grep` on the remote. Use it only when Alex asks for a
  signed installer; otherwise Windows users get a SmartScreen warning on install.
- The workflow publishes with `electron-builder --publish always`, which resolves the
  draft release **by tag on its own**. Creating the draft in Step 3 first is what keeps
  mac and Windows on one release — verify afterwards that exactly ONE draft exists
  (see Step 6) before publishing anything.

## Step 6 — Verify, and verify the right things

Cheap checks that prove nothing on their own (they pass even on a wrong-commit build):
feed reachable, release published, `releases/latest` correct.

Run these too:

```bash
# 1. all 8 assets, dash-named, no dot-named duplicates
gh release view vX.Y.Z --json assets -q '.assets[] | "\(.name)  \(.size)"'

# 2. both feeds fetch the way electron-updater fetches them
curl -sSL "https://github.com/Alexandr-Kravchuk/github-pr-manager/releases/download/vX.Y.Z/latest-mac.yml"
curl -sSL "https://github.com/Alexandr-Kravchuk/github-pr-manager/releases/download/vX.Y.Z/latest.yml"

# 3. the mac feed's sha512 matches the artifact actually uploaded
openssl dgst -sha512 -binary "dist/PR Dashboard-X.Y.Z-universal-mac.zip" | base64

# 4. the shipped bundle really contains the release's headline change
#    (content proof, not a git claim) — e.g. for the finite-animation invariant:
grep -o "\.live-beat.\{0,120\}" dist/renderer/assets/*.css     # expect a finite iteration count
grep -c "animate-pulse" dist/renderer/assets/*.js || true      # expect 0 (see note)
```

Run each of those as its own command. `grep -c` **exits 1 when the count is 0** — i.e. on
the result you want — so chaining it with `&&` silently swallows whatever check comes next.

Expected asset set: `latest-mac.yml`, `latest.yml`,
`PR-Dashboard-X.Y.Z-universal.dmg` (+ `.blockmap`),
`PR-Dashboard-X.Y.Z-universal-mac.zip` (+ `.blockmap`),
`PR-Dashboard-Setup-X.Y.Z.exe` (+ `.blockmap`). The Actions route produces these same
dash-names — but it is a different code path from `release-win.ps1`, so diff the name
inside `latest.yml` against the uploaded asset rather than assuming.

Note on `animate-pulse`: it legitimately appears in the built **CSS** as an unused rule,
because Tailwind's content scanner picks the string out of the *comments* in `App.tsx` /
`styles.css` that document the ban. Dead CSS renders no frames. What matters is **0**
occurrences in the built JS/HTML — that's what proves no element applies it.

```bash
# 5. exactly ONE draft for this tag — two means the Windows publisher made its own,
#    and publishing the wrong ID burns the version permanently (immutable releases)
gh api repos/Alexandr-Kravchuk/github-pr-manager/releases \
  --jq '.[] | select(.draft) | "\(.id) \(.tag_name) assets=\(.assets|length)"'
```

Before publishing, a draft's assets are not public, so `curl` on the feeds 404s — read
them through the API instead (`gh api -H "Accept: application/octet-stream"
repos/<owner>/<repo>/releases/assets/<assetId>`) and re-run the `curl` checks after
publishing.

Then publish — **by ID**, not by tag (`gh release edit` is ambiguous if a duplicate draft
ever appeared):

```bash
gh api --method PATCH repos/Alexandr-Kravchuk/github-pr-manager/releases/<id> \
  -F draft=false -F make_latest=true
```

Finally, confirm the update is a real transition, not a version no-op:

```bash
defaults read "/Applications/PR Dashboard.app/Contents/Info.plist" CFBundleShortVersionString
```

If the installed version already equals the new one, auto-update won't fire — see Alex's
memory on this (a build once had to be re-cut as a new patch version for exactly that).

## Release notes

Written for developers, warm but not breathless. Structure that worked:
`# 🎉 PR Dashboard X.Y.Z — <hook>`, a one-line opener, `### ✨ What's New`,
`### 🐛 Fixes`, `### 💡 Why upgrade?`, closing `*Happy coding! 🎉*`. Each bullet:
bold lead-in, plain-English what-and-why, PR link
`([#N](https://github.com/Alexandr-Kravchuk/github-pr-manager/pull/N))`.

Write to a file and use `--notes-file` (never `--notes "$(cat …)"` — the shell mangles
backticks and emoji).

**Accuracy beats punch.** Anchor every number to what the source actually claims. v1.13.0's
notes first said the release "eliminated 33% CPU" — but `AGENTS.md` explicitly frames ~33%
as *the observation that started the investigation, never an attributed delta*. The same
notes also said "if you haven't minimized the app in a while", inverting the bug: the
infinite animation burned GPU **precisely while the window was hidden**, because Electron
launches with `MacWebContentsOcclusion` disabled. Read `AGENTS.md` before making a
performance claim, and tell Alex if a hook is marketing-true but softer than the evidence.

## Waiting on long builds

Run builds with `run_in_background: true` and read the output file when notified.

Do **not** write `until … grep -q "<string>" …; do sleep 5; done` against a build log: in
v1.13.0 that loop watched for a string that could never appear (the log's last line was the
`GH_TOKEN` error) and spun forever until it was killed. If you must poll, match on a
condition that is true in **both** the success and failure cases (e.g. the process exiting),
or just wait for the task notification.

## Report to Alex (Ukrainian, short)

Version, release URL, that both platforms' assets and **both** feeds are in place, the
installed-version → new-version transition is real, and 1–2 lines on what shipped. Mention
any hook you softened.
