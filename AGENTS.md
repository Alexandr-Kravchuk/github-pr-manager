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
  pipeline's event timing. The icon's `click`/`double-click` handlers are
  registered **only off macOS**: macOS emits `click` while it is already opening
  the context menu, so on darwin they reopened the window on any click on the
  menu bar icon, bypassing the "Open PR Dashboard" item; there the menu is the
  only way back in. Both branches are pinned in `tests/run-tests.cjs` with a
  `process.platform` override. `main.ts` only injects the live actions (focus /
  quit / hide, with a leave-fullscreen-first hide for macOS); the three-way
  close decision is unit-tested in `tests/run-tests.cjs` against a mocked
  Electron, and the wiring registrations are asserted on the compiled `main.js`.
  While the PR agent is on (and Settings › Agent › Companion keeps its tray
  state), the tooltip and the menu also carry the agent: its one line
  (`agentTrayLine`), "Show agent" (the window with the companion popover, or
  the Board when the header chip is off) and "Pause agent" / "Resume agent".
  `setAgent` rebuilds the menu only when that line changed — a run reports a
  step per tool call — and `main.ts` feeds it from the throttled agent push
  *before* that push's visibility gate, since a hidden window is exactly when
  the tray is the only place to look. Close-to-tray makes hidden-but-alive the app's *normal* idle state, so the
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
  defaults), `pr-filter.ts` (the whole view-filter layer: the reveal gate, the
  filter pipeline and the chips' facet counts — the six `SOURCE_CHIPS`
  (`Needs attention`, `Failing CI`, `New comments`, `Ready to merge`,
  `No reviews yet`, `Stale`) are OR-ed **sources**, and role / host / author / search /
  `Hide my approvals` / the reveal gate narrow whatever union they produced
  (author is an exact login set by clicking an author in any view, through
  `AuthorFilterContext` and `AuthorButton`, transient like search and shown as
  a chip that switches it off);
  they were AND-ed until a pair like attention + mergeable turned out to show
  nothing and to disable the second chip through its own 0 badge, which is why
  `sourceFacetCount` is blind to the sibling sources; `roleFacetCounts` badges
  the role switch's four segments in one pass, since role is a plain AND gate;
  the `To review` segment is not the `reviewer` role but `isReviewDue` — a
  review asked of you (the role, which a re-request sets again, or your change
  request after the author acted, `myReReviewDue`) minus drafts; a PR that came
  back to you only through new comments or a push (`returnedToMe`) stays under
  `Reviewed`, so this is narrower than the `myReview` signal the
  `review-purple-prs` routine takes, and `Hide my approvals` uses the same
  "asked of you" test; `Reviewed` is the `reviewed` role minus that test and
  minus your own PRs, so a re-requested PR is listed under `To review` only and
  a reply in your own PR's thread — a "Commented" review that
  `reviewed-by:@me` matches — does not put it there),
  `issue-key.ts` (the Jira issue-link builder used by `PrCard.tsx`),
  `hotkeys.ts` (the F5 refresh
  decision and the forced-refresh cooldown shared with CmdOrCtrl+R and the
  header button), `pr-group.ts` (which Jira key a PR clusters under and what
  the heading above that cluster says — `"KEY · Summary"`, or the bare key when
  Jira resolved none; it lives here rather than as closures in `App.tsx` so the
  rendered heading is unit-tested without a DOM; "by parent task" clusters by
  the Jira hierarchy through `parentGroupKeys` — a task's PR, its subtasks' PRs
  and a parentless task's PRs land together under the cluster's top key; a
  subtask whose task has no PR of its own still reaches the epic, because the
  Jira enricher looks one level above a subtask's task (`grandparentKey`), and
  the card then names that skipped task (`hiddenParentOf`) — plus `orderStacks`, which
  keeps the PRs of one native GitHub stack together bottom-first in the
  Roomy/Compact list — and so a hand-made stack, where each PR is opened on
  the previous one's head branch: `basePrIndex` maps a PR to the listed PR
  whose head is its base (same host and repo), the card's umbrella then reads
  "on #N" and opens that PR — hovering it outlines that PR's card
  (`components/linked-pr.ts` toggles `.pr-linked` on its `data-pr-id` root, a
  class rather than React state so a hover does not re-render the list), and
  when that card is not on screen — scrolled away (the band under the sticky
  header counts, `linkedPrPlace`), filtered out or in a collapsed group —
  `BasePrMarker` hangs a preview of the PR under the marker instead — the tile's `↳` carries the number, and the map is
  built from the whole snapshot (`BasePrContext`) so a filter cannot hide the
  base's number; GitHub merges a stack bottom-up only yet reports the PRs
  above the bottom as `CLEAN`, so `canBeMerged` in `github.ts` is gated on
  `blockedByStack` and `prSignal` paints such a PR amber, not green; in the
  same way an approval that branch protection does not accept — GitHub still
  says `REVIEW_REQUIRED` with a `BLOCKED` merge state, typically while the code
  owners have not approved — sets `requiredReviewPending`, which keeps
  `canBeMerged` false, the accent off green (grey on your own PR) and turns the
  card's review pill amber; a host
  whose schema has no `stack` field is read again without it and remembered for
  the app run. The stack badge's menu is portalled to <body> because table
  cells clip with `overflow-hidden`), `view-mode.ts` (the four
  display variants behind the header's Finder-style switch — `roomy` cards,
  `cozy` table, `compact` tiles, `board` (the PR agent's work by state) — with
  the guard that validates the persisted
  choice and the two predicates App.tsx gates grouping and the sort dropdown on),
  `pr-table.ts` (the Cozy table's twelve columns — the Agent one only while the
  PR agent is on (`visibleColumns`) — and its ordering: a comparator
  per column, always ascending in terms of what the cell SHOWS, plus what a
  header click does) and `claude-launch.ts` (the opt-in "start Claude on this
  PR" button: which prompt a PR's state picks — blocked → drive, review due →
  review, own mergeable → close, else the bare link — plus the shell quoting;
  the renderer imports it for the tooltip, while finding the checkout by git
  remote live in `main/claude-launch.ts` and opening the terminal in
  `main/terminal.ts`, and the
  renderer sends only the PR id (plus a picked kind and an in-terminal
  boolean) so nothing it supplies reaches the shell; while Settings open
  sessions in Claude Desktop the menu also offers "Review in terminal"
  (`claudeMenuItems`), which opens the default terminal instead — with a
  terminal chosen, "Review" already does that, so the item is hidden; a
  Jira-key group heading also has a split Claude button beside its PR count
  with two group launches — "Explain all" (one session that explains the
  group's open PRs together, no letter) and "Review all" (a parent session
  that starts one nested session per PR awaiting your review through Claude
  Desktop's `start_session` tool and sums their reports up; nesting only
  exists in Desktop, so with a terminal the item is disabled and says why).
  Both send only the kind, the key and the PR ids; main picks the PRs again
  (`groupLaunchPrs` — review takes `isReviewDue` only, so never your own PR)
  and runs in the checkout of the repository most of them belong to; Review
  all also names, for each PR from another repository, that PR's own
  checkout (`in <folder>:`, started through `start_session`'s `cwd`), since a
  review in a foreign folder loads that folder's CLAUDE.md as its rules and
  searches the wrong code. The parent also adds to every nested prompt, word
  for word, the user's permission to publish the review on the PR (never
  `APPROVE`), since a request from another session is not the user's
  consent; a default prompt is stored empty and an old default saved
  verbatim is read through `PREVIOUS_DEFAULT_PROMPTS`, so a changed default
  reaches every user who never edited it. Each
  prompt starts with `groupMarker(kind, key)`: the session scanner records it
  as the session's `groups` instead of binding the session to every PR it
  lists (a marker line counts even with no PR link, since a custom template
  need not list any; and a group session never holds a card through its
  folder's branch) — also once Desktop pauses it, through `groupsSeen`, which
  is kept in `userData/claude-group-sessions.json` so a dashboard restart
  does not hand a paused group session every PR Desktop bound to it — and the
  heading's button then shows that session's status in its kind's words
  (`GROUP_STATUS_TEXT`) and switches to it, like a card's button),
  `claude-sessions.ts` (which running Claude Code session works on which PR:
  a session counts when the user sent it the PR's link — only human prompts,
  never tool results, peer messages or task notifications, which quote PRs the
  session was never asked about — or when its folder is a checkout of the PR's
  repo on the PR's head branch; `main/claude-sessions.ts` reads Claude Code's
  own live registry `~/.claude/sessions/<pid>.json` (skipping `spare` processes
  started ahead of the next session; a `kind: "bg"` session runs in the
  daemon's pty, so no terminal tab has its tty) plus each session's transcript
  incrementally, on a 5 s timer gated on window visibility like the snapshot
  pushes. Claude Desktop pauses idle sessions — stops the process, keeps the
  session — so its own records (`claude-code-sessions/*/*/local_*.json`:
  `isArchived`, the `prs` bound to it, `scheduledTaskId`) add those as
  `paused` and drop archived ones; routine runs are left out because one run
  touches every PR it drove. Those records are re-listed every 60 s and only
  the last 14 days are read — thousands pile up. While a session holds a PR, the Claude button's main part
  switches to it — Desktop through `claude://claude.ai/epitaxy/<hostSessionId>`,
  a CLI session through the iTerm2/Terminal tab on its tty — and launching a
  second one moves to the menu, since two sessions on one PR edit the same
  branch),
  `settings-search.ts` (the Settings screen's tabs, which section sits on which,
  and the keywords its search box matches — every word of the query must hit a
  section's title or keywords; a setting whose label is missing there cannot be
  found, so extend its keywords when adding one), `host-status.ts` (the
  colour of a header host pill's dot — red on a failed fetch, amber on a spent
  or low GraphQL budget, green otherwise; the pills replaced the raw budget
  number and, with two or more hosts, the "All hosts" dropdown, since clicking a
  pill toggles that host's filter), `jira-status.ts` (how the renderer
  loads the Jira status: the cached answer first, a fresh `twg whoami` only
  while twg is still `checking` or on Check again, and every answer to a load
  that a later one replaced is dropped), `stale.ts` (long-open PRs: the
  `staleAfterDays` threshold — counted from `createdAt`, 0 is off — behind the
  poller's `isStale`, the `Stale` chip and badge, and the close dialog's rules:
  only your own stale PR offers "Close…", which closes it on GitHub and can move
  its Jira task back to To Do, close it as Won't Do or delete it. Workflows
  differ per project, so the dialog lists the transitions Jira offers and
  `suggestTransition` only preselects one. The close runs in
  `main/stale-close.ts` with every outside call injected: the renderer sends
  only the PR id and its choices, the PR is closed first and the task second,
  and a missing Jira token stops it before anything changes. Jira writes need a
  token with write scope — the read-only one the Jira section recommends gets a
  refusal that says so) and the PR agent's nine: `agent-explain.ts` (the
  Board in plain words — each card's owner (you, the agent, others, nobody),
  what is happening, what is needed from you, what to read, every button with
  what it does, and what comes next; `explainBoard` orders them) and
  `agent-defaults.ts`
  (the Agent tab's defaults and bounds), `agent-stream.ts` (a run's
  stream-json read into its plan — the `TaskCreate`/`TaskUpdate` list, or a
  skill Workflow's phases — and current activity), `agent-view.ts` (where a
  PR stands — `boardStage`: the column is whose move it is, the agent's
  (queued, working), yours (a move it prepared: Send review, Push N fixes,
  Your call, Merge, Draft a review, a run that failed — or GitHub's say-so with
  the agent not on it), the people you wait on, or done today; a run that asks
  nothing, stopped or taken over, is a note on its card. A PR whose review is
  asked of you again while your approval stands on its head and the author
  hasn't answered since (`approvalStands`) is not your move: it sits in Done
  with that line (`askedAgain`) and "Approve again" under its More — an
  `approveAgain` action on the PR, not an item: main reads the PR again and,
  only if that still holds at the same head, posts an APPROVE of that head
  with one line and the signature, logged as `run/approved-again`; a review
  you ask for that finds the same says "Already approved on this head".
  Asked again after a change request of yours on that same head, the
  re-review runs by itself (`planJobs`, once per head and request): the
  request is the author's "look again". A review asked of you starts without
  a click on a big PR too: its brief comes first, and once that brief of the
  head is written (`briefDone`) the plan queues the review, which takes the
  brief over (`takeBrief`: the brief closes, its questions for the author go
  into the review's prompt and its text onto the review's card, and the brief
  alone sends no toast). "Draft a review" is left for a brief no review
  followed — reviews off, or the request gone. A run the agent planned
  itself that fails (`fail`: a checkout the network refused, a crashed
  session) is tried once more by itself `RETRY_AFTER_MS` later (`retryAt`
  on the failed item, `dueRetry` in the plan; the new run carries
  `retryOf` and is not tried a third time) while the plan still wants that
  head — not a run you asked for, not one cut short again and again; the
  card, the toast and the PR's reason say when. A PR's reason when it is
  idle comes from what the head's run really did (`ledgerIdle`): "Running"
  only while it is live, else how it ended, and every run's end plans
  again at once — except one taken over, cut short or ended by the
  switch-off — so no reason waits for the next poll. A drive's result
  from before the app last started is marked `needsRerun` at start: its
  push and its answer are checked against what the app took in memory
  (`pushTo`), so its card offers Run again (and Open in Claude) instead of
  a question's buttons or a Push that would only be refused, and shows the
  question as what the new run will ask. A refused action's message shows
  on the open card it came from, not only at the top of the Board. A
  move ready for you names itself wherever the PR shows — the Roomy line's
  button ("Send review →", "Push 2 fixes →") and the Cozy cell open its card
  on the Board, the one place it is sent from, since a bare "Open" left an
  approval waiting two days unfound — and the words every
  surface says it in: a card's line, the Cozy cell and tile, "ready for you"
  (`readyItems`) on the chip and the tray, a notification's title; the *local*
  day "Done today" and the daily run limit count on, quiet hours
  (`quietUntil`, a span that may wrap past midnight), and which regular toasts
  the agent stands in for — `agentTakesToast`: a trigger it took in On;
  `main.ts` hands it the snapshot before deciding the toasts) and
  `agent-result.ts` (what a run's final message means for its Your-move card:
  every session is told to end with a fenced `prd-result` JSON block — one
  summary sentence, the questions only you can answer, findings by severity —
  read here and held to its shapes; a message without it gets its first real
  paragraph as the summary; answering a question from the card resumes the same
  session with your answer) and
  `agent-publish.ts` (what a review prepared to post: a review session never
  posts — its skill's `publishCommand` is a wrapper of the app's that only
  records each write, checked like the skill's own `pr-review-publish.sh`, and
  the app posts the plan with `gh api` afterwards, signature added, one write
  at a time with progress on disk so a retry never posts twice) and
  `agent-diagrams.ts` (Mermaid diagrams of a PR's change — Settings › Agent ›
  Diagrams: after a review or a brief of a PR at least `minLines` big,
  `main/agent/diagrams.ts` runs one short `claude -p` of its own — no tools,
  `--restricted --strict-mcp-config --no-session-persistence`, in a folder of
  the app's, the PR's title, summary and diff on stdin — while the item is still
  `working`, so its slot stays taken and nothing goes out without them. The
  answer is untrusted model output posted under your name: only a plain
  flowchart or sequence diagram passes `isSafeMermaid` (no fence, no tag but
  `<br>`, no click/link/`url()`/init/`@{…}`), titles are stripped to words, one
  that looks like it carries a secret is dropped whole. A flowchart can't be
  parsed without a DOM, so main asks the renderer (`agent-check-diagrams` →
  `agent:diagramsChecked`, one boolean per source back, never text) and posts
  none unchecked. A review's diagrams are its plan's last write, a `note` step
  (an issue comment, signed) that only the app adds — the capture script has no
  such write — and none is drawn or posted while the PR's conversation already
  has a Mermaid comment, whoever drew it (the creatio-pr-watch reviewer draws
  the same kind, with the same three colours). The card renders them with the
  renderer's own mermaid, loaded on first use, labels as SVG text and the SVG
  sanitized again to SVG only — HTML in a `<foreignObject>` came out empty) and
  `agent-reapprove.ts` (approvals a base-only push dismissed — a branch rule
  that dismisses approvals on every push takes them away when the base is
  merged in, though nothing of the PR changed. Two offers with a button, like
  a merge offer, never a session: `reapprove` gives your approval again on
  someone's PR, `reask` asks your PR's reviewers again. The policy points at a
  PR from its state alone — someone's PR you reviewed with no approval or
  change request of yours standing, or your PR with no approval left — and
  holds someone's PR (no review of its head starts) until main has read it:
  once per head (`ReapproveMark`s in `state.json`, by ledger key),
  `main/agent/reapprove.ts` reads the PR's timeline — a reviewer's latest
  review DISMISSED and the `ReviewDismissedEvent` of that very review, matched
  by review id (author and commit can match an earlier dismissed approval),
  saying it was APPROVED, so a dismissed change request never becomes an
  approval and any later word of theirs wins — and then checks the push in
  your clone (`baseOnlyPush`; no clone, no offer): everything between the
  approved head and the new one must be merges of the base on the branch's
  first-parent walk (`baseMerges` over `rev-list --parents old..new --not
  <base>`), and each merge's tree exactly what `git merge-tree --write-tree`
  makes of its two parents — so an own commit, a rewrite, a conflict resolved
  by hand or a merge carrying changes of its own all pass. Diffs were compared
  first and dropped: a change moved to a spot with the same context, or a
  `--- `/`+++ ` content line read as a header, slipped through. The git calls
  run under `withNoHooks` + `safeGit` and leave the clone as it was — the
  fetch takes `--no-write-fetch-head --refmap=`, so not even a remote-tracking
  branch moves (a test pins both on a real repository).
  Shadow offers it, On gives it at once; the PR is read again before anything
  goes out, the approval carries one line and the signature, and turning an
  offer down hands the head back to the other rules — a read that failed is
  tried again ten minutes later, never by the plan it ends in, which would
  start it over at once) and
  `agent-stack.ts` (the agent and GitHub's native stacks: each layer's diff is
  its own, the stack merges only with a linear history, and GitHub rebases
  the layers above after a lower one merges — so a session on a layer is
  told its place (`stackRules`: a review keeps to its layer, a finding in a
  lower layer's code is a note, not a comment here; a drive never merges the
  base in), a layer of yours that conflicts gets no drive but a "Rebase
  stack" card (the agent never rebases or force-pushes — the button on
  GitHub, or `gh stack rebase` + `gh stack push`), only the lowest broken
  layer of your stack is driven (`brokenLayerBelow`; the ones above wait),
  a drive's commits with a merge in them are neither kept at the run's end
  nor pushed (`collectDrive` counts merges), and a push to a layer with open
  layers above says they need Rebase stack. Not stack-only: a PR you
  reviewed that got a push and nothing else since — no reply, not asked
  again — is held while main checks in your clone that the new head is the
  change you reviewed on a new base (`checkBaseOnly` / `sameChangeOnNewBase`
  in `main/agent/reapprove.ts`: "the change you reviewed" is the reviewed
  head against the base it had then, put onto the base commit the new head
  sits on with `git merge-tree --merge-base`, and the result must be the new
  head's tree exactly — a stack GitHub rebased, a Rebase stack, the base
  merged in). The base it had then matters — a layer retargeted onto the
  trunk without the layer below merged carries that layer's code in its
  diff now — and it is taken from GitHub's own records only, never from a
  branch tip, which whoever pushes to it chooses: one read of the PR's
  timeline since your review; nothing there means the same branch, moved
  forward; one `BaseRefForcePushedEvent` (a lower layer GitHub rebased)
  means the tip it records from before; one `BaseRefChangedEvent` (moved
  onto the trunk when the layer below merged) means that lower PR's head as
  GitHub kept it at the merge — the only PR of this very repository, never a
  fork's, merged from the old branch into the new base after your review.
  Anything else — two changes, a second page, no such single PR — is
  "changed": the check fails closed. Then no re-review runs; once per head
  and base (`baseOnly` marks in `state.json`, keyed
  `…|rereview|<head>|base`, holding the base they were for), with commits the
  clone lacks fetched by id; no clone or another review of yours since makes
  it "changed" or looks again, and a failed check waits ten minutes like
  re-approve's. The merge itself is not adapted yet: GitHub's
  synchronous merge API, which `gh pr merge` uses, does not support stacked
  PRs — the asynchronous `merge-async` endpoint does).
  The header sky has its own: `weather.ts` (WMO weather code → one of
  seven skies, and parsing Open-Meteo's geocoding and forecast answers;
  `main/weather.ts` fetches them for the city in Settings — the only thing
  that leaves the machine, so an empty city sends nothing and the header
  keeps its snow — and caches the answer 30 min, a failure 5, keeping the
  last good sky through a failed refresh; the `weather:get` channel takes no
  argument, so the renderer cannot point the request elsewhere). Keep any such
  module Node-free — a `node:` import there breaks the renderer build (Vite fails
  to bundle it). A guard test in `tests/run-tests.cjs` asserts the compiled
  `notify.js`, `pr-filter.js`, `issue-key.js`, `hotkeys.js`, `pr-group.js`,
  `pr-table.js`, `view-mode.js`, `claude-launch.js`, `claude-sessions.js`,
  `settings-search.js`, `host-status.js`, `jira-status.js`, `stale.js`, `agent-defaults.js`, `agent-publish.js`,
  `agent-stream.js`, `agent-result.js`, `agent-view.js`, `agent-diagrams.js`,
  `agent-reapprove.js`, `agent-stack.js`, `agent-explain.js` and `weather.js` stay free of `node:` builtin references, so the
  invariant can't regress unnoticed; extend that list before value-importing
  another `shared` module.
- **renderer** (`src/renderer`, Vite + React + Tailwind v4) — the dashboard UI.
  It talks to main **exclusively** through `window.api` (the preload bridge):
  no direct network, no Node access (`contextIsolation` on, `nodeIntegration`
  off). The list renders in one of four display variants, chosen by the
  Finder-style `ViewSwitch` in the header row next to Refresh and persisted with
  the other view preferences in `localStorage`: `roomy` (`PrCard`, the original
  full cards and the default), `cozy` (`PrTable`), `compact` (`PrTile`) and
  `board` (`PrBoard`: what needs you first, then what doesn't — a sentence of
  how much is yours; Your turn, every decision as an open card, readiest
  first (a merge or an approval in one click, then a question or a brief, a
  failure, then a review nobody started), each saying what happened, what to
  read (the summary, findings, what goes out on GitHub, the commits, the
  pushed-back comments), your move with what its button does, and what comes
  next; then rows that ask nothing of you — the agent is on it, waiting on
  others, done today — each with what comes next and what you could do one
  click away. Where a PR stands is still `boardStage` in
  `shared/agent-view.ts`, one pure function the chip and the tray read too,
  so a PR shows once; the words are `shared/agent-explain.ts`. A card nobody
  started (asked of you, red CI) offers "Let the agent …" first and GitHub
  second, never only a link. The two lanes are a tag on each card, not rows
  of columns: a move was missed for days among eight equal columns. The
  three variants it was picked from are on the `prototype/board-redesign`
  branch. Like Cozy it turns off Group-by and Sort).
  Roomy and Compact are the same grid at two densities — one `PrList` renders
  both, so their column counts are the only difference and can't drift. Cozy is
  the odd one out and deliberately so: it is one FLAT table sorted by any
  column, because a table per group would sort inside its group only and could
  not answer "the oldest PR of all of them"; while it is on, `App.tsx` skips the
  grouping pass and both the Group-by and Sort dropdowns are disabled rather
  than hidden, so it is visible which control took over. Its rows sort through
  `shared/pr-table.ts`, where each column also declares a `minWidthRem`;
  `TABLE_MIN_WIDTH_REM` sums them and goes on the table as a `min-width`,
  because a fixed-layout table ignores a `min-width` set on the cells — that one
  number is what keeps a narrow window from squeezing the title column down to
  one letter. Every column is resizable (a grip on its header edge, drag or
  arrow keys, double-click to reset; the dragged widths persist in rem as one
  `tableColumnWidths` map with the other view prefs, and cells clip with
  `overflow-hidden` so a narrowed column can't paint over its neighbour). The
  Pull-request column is the elastic one: until it is dragged it carries no
  width and absorbs the window's slack, and once dragged a trailing auto-width filler
  column takes the slack instead — a declared width on every column would
  otherwise have the browser spread the leftovers proportionally and silently
  widen the column just set to an exact size. The table scrolls inside a box
  whose height is *measured* down to the bottom of the window (`useScrollerHeight`)
  rather than a `calc(100vh - Xrem)`: the filter row above it wraps to a second
  line on exactly the narrow windows where the horizontal scrollbar matters. The
  box is what makes that scrollbar visible at all — a scrollbar sits at its own
  element's bottom edge, so while the page did the scrolling it lived below the
  fold and a table clipped on the right looked complete. Two traps that measuring
  walked into: the floor on that height must stay small (a floor taller than the
  space actually left pushes the box's bottom, scrollbar included, back below the
  window), and it re-measures in a `useLayoutEffect` after every commit rather
  than through a `ResizeObserver` on the page — the page's height includes the
  box, so the observer saw its own effect, Chromium dropped notifications, and
  the box kept a stale height across a window resize. `.table-scroll` in
  `styles.css` styles the bar for the same reason: macOS's overlay scrollbars
  fade out seconds after the last scroll.
  In Compact, the tile's one glyph row is where the signals the card spells out
  in pills live (role letter, review tally, back-to-you / stacked / new-comments
  / conflict markers, thread count, CI) — each with its own `title`, since a
  glyph row is only readable once you can ask what a glyph means. The tile title
  is clamped with `line-clamp-2` and must NOT also
  carry `block` — the clamp works by `display: -webkit-box`, so a `block` next
  to it wins on stylesheet order and the titles run to any number of lines,
  which is what made the tiles in a row different heights.

## Build / run

- `npm run dev` — Vite dev server (HMR) + Electron pointed at it. The main
  process compiles in `tsc --watch` and Electron restarts after each clean
  build: it reads `dist/main` only at startup, so a one-off compile kept a dev
  app on stale main code while the renderer hot-reloaded and looked current.
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
  the loading state. Both actions surface the window first (`createMenuActions`,
  unit-tested): close-to-tray makes hidden-but-alive the normal idle state, and
  on macOS the app can be frontmost with no window on screen, so a shortcut that
  only pushed an event would look dead while still spending a GraphQL request. `CmdOrCtrl` covers both platforms — Cmd+, / Cmd+R on macOS,
  Ctrl+, / Ctrl+R elsewhere. Two traps the template exists to avoid:
  `setApplicationMenu` **replaces** Electron's default menu, so the role-based
  menus have to be re-declared or Cmd+C/V/A in the search and Jira-token fields
  disappear; and the macOS `windowMenu` role omits Close, so `{ role: "close" }`
  is spelled out or Cmd+W (the close-to-tray gesture) silently stops working.
  The `reload` role must stay out — it would claim CmdOrCtrl+R and shadow
  Refresh. F5 is the second Refresh shortcut and is handled by a renderer
  `keydown` listener, because one menu item carries exactly one accelerator and
  a hidden duplicate item's accelerator is not reliable across platforms. Its
  decision lives in `shared/hotkeys.ts` (`shouldRefreshOnKey`, another Node-free
  value-import carve-out) so it is unit-tested without a DOM — and it excludes
  OS key auto-repeat, or holding F5 chains forced polls: the renderer's
  in-flight guard drops only the presses that land *during* a poll. That guard
  alone does not cover a burst of *distinct* presses (a fast double-tap, or
  CmdOrCtrl+R held — the menu carries no `repeat` flag to filter on), so
  `App.tsx`'s `refresh()` — shared by the header button, CmdOrCtrl+R and F5 —
  additionally gates on `shouldAllowForcedRefresh`, a short shared cooldown
  timestamp also in `hotkeys.ts`. Both shortcuts are suppressed while the
  Settings screen is open: a refresh there would spend a GraphQL request behind
  a screen that shows none of it, and switching the view out from under an
  in-progress edit (a half-typed Jira token) was rejected instead.
- Settings never contain tokens; tokens are resolved per host via `gh` at fetch
  time (`config.ts`).
- Jira is read through the Atlassian `twg` CLI first, the API token second —
  the `gh` model again: twg signs in with OAuth and refreshes itself, so there
  is nothing to expire. `shared/jira-pass.ts` picks the source per pass (twg
  not installed → token silently; twg signed out → token, reported only when
  the token can't run) and is unit-tested with an injected twg runner. A twg
  that hung or failed is skipped for a number of *passes*, not seconds: the
  next tick starts a full poll interval after this one ends, so any time
  window shorter than that interval has always expired by then.
  `main/twg.ts` owns the processes, `shared/jira-twg.ts` the arguments, output
  parsing and failure classes. The sign-in terminal opens through
  `openTerminalWith` in `main/terminal.ts`, the one terminal launcher.
  `jira:status` never waits on `twg whoami` (it can take many seconds while
  twg renews its session): it answers with the last known twg status, or
  `checking` before the first, and one shared `whoami` refreshes it
  (`createTwgStatusCache`). A twg that fails on the subtask parents backs off
  as well, since the issues themselves then come from the cache. Every twg run passes `--mode user --output json
  --output-summary none`, or an inherited `TWG_AGENT_DEFAULTS` swaps the JSON
  for a YAML envelope. Tests must inject a runner (`buildJiraEnricher(…, {
  runTwg })`): the default spawns the machine's real twg. The issue caches are
  per source, so one source's "not found" never hides a key from the other.
- A rejected API token is NOT a 401 on the site URL: Jira serves it
  anonymously as `200 {"issues":[]}` and says so only in
  `X-Seraph-LoginReason: AUTHENTICATED_FAILED`. `fetchTokenChunk` checks that
  header (failure values only) on every response, pinned base included, and
  throws `JiraAuthError` before anything is cached — only on a trusted answer
  (`resultIsTrustworthy`): a scoped token that reached the site alone because
  the gateway was skipped is refused there too, so that is a plain error,
  retried next pass — counted as a trusted
  answer, the anonymous 200 would pin the site base, write a negative entry per
  key and show as "no parent tasks resolved". The `auth` health drives a banner in every grouping, one OS
  notification on the transition into it, and the pass stops sending that
  credential until the token, the account email or the site changes. The
  Settings header names the source that can sign in now (`signInSource`: twg
  signed in, or a token with its email), never `configured`, which stays true for a
  signed-out twg so the saved grouping survives. Atlassian has no API that creates a user's API
  token, so the banner can only link to id.atlassian.com (or start
  `twg login --force` in a terminal).
- Window size/position persist in `userData/window-state.json`
  (`main/window-state.ts`), **not** in `settings.json`: `loadSettings()` throws
  `ConfigError` on an unexpected shape and the poller surfaces that, so a stray
  geometry value must never be able to make the app look unconfigured. The
  geometry rules are pure in `shared/window-bounds.ts` — the display list is a
  parameter, since `screen.getAllDisplays()` is only valid after
  `app.whenReady()` and passing it in is what makes the off-screen cases
  unit-testable. Saved bounds are dropped (back to the centered default) when no
  display they still intersect exists, so a window from a disconnected monitor
  cannot come back unreachable. `getNormalBounds()` plus separate
  `isMaximized`/`isFullScreen` flags — `getBounds()` on a maximized window would
  persist screen-sized bounds as the "normal" size. Writes are debounced on
  move/resize and **flushed on `close` before `trayController.handleClose`**:
  close-to-tray may hide the window, and a hidden window's bounds are not
  reliable.
- Launch at login starts the app **in the tray** when close-to-tray is on
  (`main/login-launch.ts`): the Windows Run-key entry carries `--hidden`
  (macOS relies on `wasOpenedAtLogin`, best-effort — login items there take no
  arguments). The first window is then created with `show: false`, and it is
  shown anyway if the tray icon failed to appear, since a hidden window with no
  icon is unreachable. The saved maximized/full-screen state waits for the
  first `show`, because `maximize()` would itself show the hidden window.
  The Run-key value is named after the AppUserModelID, so a build that ran
  before `setAppUserModelId` left an `electron.app.PR Dashboard` value behind
  and the app started twice at sign-in, once without `--hidden`;
  `staleLoginItemsFor` deletes it on every apply, whatever the preference is.
- `PRD_DEBUG=1` enables main-process diagnostics; `PRD_SMOKE_EXIT_MS=<ms>` makes
  `electron .` self-quit after the renderer loads (a non-interactive boot check).
- **The PR agent's log** is `userData/agent/log.jsonl` — one JSON line per
  event, kept for Settings › Agent › Policy's retention (its "Show the log"
  opens the folder). Read it first when the agent did something odd. Every line
  has `at`, `kind`, `event`; most have `prId`/`prNumber`/`repo`/`runId`, a
  change has `from`/`to` and `ms` (how long the `from` side lasted), the rest is
  in `data`. Kinds: `run` (a run's own steps — `queued` with mode, reasons and
  PR size; `started` with its folder, model and queue wait; its end,
  `needsYou`/`done`/`failed`, with time, turns, cost, tokens, tool calls,
  refused tools and stderr's tail; `interrupted` when its process was ended
  under it; `diagrams`; `published`/`pushed`/`merged`/`reapproved`/`reasked`
  and their `not-*` refusals; `approved-again` (no run: your Approve again);
  `offered` for an offer; `notice`), `item` (every
  state change of an item), `board`
  (a card's column or button changed: `seen` on the first look, `move`,
  `action`, `left`), `plan` (why the agent leaves a PR alone — `idle` — what
  holds the queue — `held`/`released` — what a head's re-approve check
  found, `reapprove-check`, and whether a reviewed PR's new head was the same
  change on a new base, `base-check`), `action` (each `act`, i.e. each
  click, with its result) and `agent` (start, stop, `on`/`off`, `settings`
  path by path). State changes are found by diffing in `main/agent/journal.ts`,
  run before every save (`openStore`'s `beforeSave`) and after every plan, so a
  new code path can't leave a hole in them; run events are written where they
  happen. Board lines use the same `boardStage` as the Board, over all PRs
  rather than the filtered ones, and only while the agent is on — pruning runs
  only then; their marks persist in `state.json` (`board`), so a restart logs
  what moved while the app was closed rather than every card again.
- **No hook of a PR's repository runs for the agent.** A relative
  `core.hooksPath` (husky v9's `.husky/_`) resolves inside the worktree, so a
  hook there is the PR's own script. Every git command the app runs in a clone
  or worktree goes through `safeGit` with a fresh empty hooks folder
  (`withNoHooks`, `main/agent/drive.ts`) — the worktree's `fetch`, `worktree
  add` (post-checkout, reference-transaction) and `remove` included — and
  every session's environment carries `sessionGitEnv` (`main/agent/runner.ts`:
  `core.hooksPath` at the run's own empty `no-hooks` folder, no fsmonitor, as
  `GIT_CONFIG_*` entries that win over every config file), so neither a drive's
  `git commit` nor Claude Code's own `git status` runs one. The guard hook
  (`main/agent/hook.ts`) reads back every field of the guard file — a `subs`,
  `workDir`, `readDirs`, `sessionId` or `sessionRoots` that is there but
  malformed gives no file access at all, since a missing `subs` means every
  wrapper subcommand, and a folder list keeps absolute paths only — and
  follows a drive's write through links (`checkRealWrite`): `checkDriveWrite`
  alone is lexical, and a link committed in the branch would lead it out of
  the worktree. A merge
  keeps the branch while open PRs build on it (`builtOn` in
  `main/agent/merge.ts`): gh's own delete can win the race with GitHub's
  retargeting and close them.
- **An agent session reads its own folders only, and uses only the tools the
  guard names.** A PR's diff, description or comments can tell a review to
  read `~/.config/gh/hosts.yml`, `~/.ssh/*` or `userData` and quote it in a
  comment, which On posts unseen. So `checkToolUse` (`shared/agent-guard.ts`)
  holds `Read`, `Grep`, `Glob`, `LS` and `NotebookRead` to the guard file's
  `readDirs` — the run's working folder (`workDir`, now written for every
  kind of run: relative paths and a Grep/Glob with no path mean it), its
  payload folder and the plugin folders it mounted (`prd-user-skills`
  included; a skill reads its own files and Workflow script there) — plus
  Claude Code's own folder for the session, `<root>/<project>/<sessionId>/`
  under `sessionRoots` (`claudeSessionRoots` in `main/agent/runner.ts`:
  `projects` in its config folder, `claude` in its temp folder), where it
  spills a tool result too long to show and a background Workflow's output
  and tells the session to read them; another session's folder there is
  refused. `~`, `..`, a colon past the drive letter and an absolute Glob
  pattern or brace alternative outside those folders are refused. The hook
  passes `realRead` (links and junctions followed, Git Bash `/c/…` read as
  `C:\…`, 8.3 short names resolved), so a link the PR's branch carries is
  judged by where it leads — `--restricted` already keeps Read to the working
  folders, but that is Claude Code's rule and it judges a link by its name.
  A git flag that reads a file it names — `commit -F`/`-t`, `merge -F`,
  `blame --contents`/`-S`, `--pathspec-from-file`, `diff -O`, `ls-files
  --exclude-from`, any abbreviation git expands to one (`--fil=`) — is held
  to the same rule (`checkGitFiles`, an absolute path only), or `git commit
  -F ~/.ssh/id_rsa` would carry a key into a commit the app pushes; it is
  not refused outright, since a drive writes its commit message into its
  payload folder and commits with `-F` (`$(…)` and heredocs are refused).
  Any tool the guard doesn't name is refused (`SESSION_TOOLS` lists the
  harmless ones: `Skill`, `Agent`, `ToolSearch`, `TaskCreate`, `TaskUpdate`,
  and `StructuredOutput`, which a Workflow's agents answer through); a test
  pins that every tool the default `--allowedTools` lists grant is one the
  guard knows, so extend the guard before adding a tool to the defaults.
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
  fires — see `.live-beat` in `styles.css` (one
  blink per snapshot) and `.claude-glow` (three breaths of a PR card's glow
  when a Claude session on it starts working or waiting; only its own layer's
  `opacity` animates, so nothing repaints per frame). The header sky
  (`HeaderSky.tsx`: snow, rain, thunder, clouds, fog, sun, stars — from the
  weather) is the one animation that runs for as long as something holds it:
  every moving part carries `.sky-anim`, which plays only while the pointer is
  over the header and is `animation-play-state: paused` otherwise (a test pins
  both rules and that each animated element carries the class), with a finite
  iteration count. The play-state rules are two-class selectors on purpose:
  the one-class `animation` shorthand resets the play state. Key it on something monotonic per event: `App.tsx` uses a
  snapshot counter, because `snapshot.fetchedAt` is
  the *oldest* host's stamp and stalls. A guard test in `tests/run-tests.cjs`
  scans `.ts`/`.tsx`/`.css`/`.html` under `src/renderer` for
  `animate-{pulse,spin,bounce,ping}` (bare or arbitrary-value) and for literal
  `infinite` iteration counts, so this can't regress unnoticed. The scan does
  not see a dependency's stylesheet: mermaid's ships an endless dash animation
  for edges marked `@{ animate: true }`, so the diagram guard refuses `@{` and
  `.agent-diagram svg *` sets `animation: none`.
  Related: `backdrop-blur` on the sticky header is free at rest but multiplies
  the cost of anything animating beneath it (~3x in one dev-instance A/B) — keep
  animations under it short and finite.
