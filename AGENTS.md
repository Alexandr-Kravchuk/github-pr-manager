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
  remote — in the projects folder, or with none set in the usual places
  (`checkoutRoots`: `~/Projects`, `~/source/repos`, `~/src`, `~/code`…, so a
  fresh install finds clones it was never told about — under your home only,
  never a drive root's `C:\Projects`, which any user of the machine may
  create and plant a "checkout" in for the agent to run git in) —
  live in `main/claude-launch.ts` and opening the terminal in
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
  searches the wrong code. The parent passes the saved publication permission
  verbatim to each review session via `{permission}`. Single Claude and Codex
  review launches use the same two explicit opt-ins under Settings →
  Integrations → Claude. Both default to chat and each applies to its own
  formal verdict on the reviewed head; a grant also carries what makes a
  verdict eligible (an APPROVE only with no Blocker and no Major of any
  confidence and only while the reviewed commit is the head; a low-confidence
  Major backs REQUEST_CHANGES only once checked), and your own PR or a draft
  never carries one (`reviewConsentFor`, the one rule for a single launch and
  for Review all, where a draft or your PR among the group takes it away). The
  switches show in Settings with Claude sessions off too, since the PR agent
  reads them. Every such launch, granted or not, tells the session to
  run the review workflow with `dryRun: true` (`REVIEW_DRY_RUN`) and post the
  verdict itself: the workflow's own publish APPROVEs an "approve (minor
  issues)" over a low-confidence Major, which the rule above forbids. The PR agent reads the same two opt-ins: in On, a
  review's APPROVE or REQUEST_CHANGES without its opt-in goes out as a COMMENT
  with a note (`consentHeld`, like a held approve — not a failure), and an
  On re-approval without the Approve opt-in waits as an offer; a Publish or
  a re-approval you click is its own authorization (`currentReviewConsent` is
  passed only when `!byYou`). The scenario mode decides whether the agent
  posts at all, these opt-ins which verdict it may post. A default prompt is stored
  empty and an old default saved
  verbatim is read through `PREVIOUS_DEFAULT_PROMPTS`, so a changed default
  reaches every user who never edited it — the agent's prompts too
  (`toStoredSettings`, `PREVIOUS_DEFAULT_AGENT_PROMPTS`). Each
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
  a CLI session through the iTerm2/Terminal tab on its tty (with two or more
  sessions on the PR or group the main part opens the menu that lists them
  instead, since its status can't say which one a click means; the menu is
  anchored on the whole split button) — and launching a
  second one moves to the menu, since two sessions on one PR edit the same
  branch; for the same reason the PR agent starts nothing on such a PR — not
  its plan, not a run you ask for or answer, not one that waited in its queue
  while the session opened (`yourSessionOn` in `main/agent/index.ts`; its own
  run continued in your terminal counts, and so does one Desktop paused — it
  may be waiting for your answer — whose refusal says to archive it; the plan
  reads the same list and runs again whenever the list changes
  (`sessionsChanged`), or a PR whose session ended would keep its reason until
  the PR moved), and the Board offers no "Let the agent …" there
  (`OWN_SESSION_WHY` in `shared/agent-view.ts`)),
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
  (the Agent tab's defaults and bounds: off until switched on, then every
  scenario On — the settings the agent is run with day to day, so a fresh
  install works without a round of tuning; Shadow is a per-scenario choice
  and a merge is only ever offered. Those defaults fill only settings with
  no agent saved at all: in saved ones a posting scenario's mode that is
  missing or unknown is Shadow (`validateAgent`), since falling back to On
  would post and approve under your name unchosen. Model and effort are per
  kind of run too (`runModels`, Settings › Agent › "Per kind of run"):
  `runModelFor` takes the kind's own, else the agent's `model`/`effort`, else
  Claude Code's default, and `run/started` logs what the run got. Every kind
  defaults to the agent's (the brief's Sonnet is unread: no briefs are
  written); an absent field reads as the
  default, a saved empty one as the agent's, and a model is a name only
  (`isModelName`: it goes on a command line). "Reviewers on Sonnet"
  (`sonnetReviewers`, on by default) adds `SONNET_REVIEWERS_RULE` to the
  rules of the runs that start the review workflow (`runsReviewWorkflow`: a
  review, a re-review, a self-review): the creatio-code-review workflow takes
  `reviewerModel: "sonnet"` and then runs each reviewer as the plugin's
  `<reviewer>-sonnet` agent, pinned in its frontmatter, since the Workflow
  runtime's `agent()` has no model option; a host env with
  `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` overrides that pin). "Small PRs: the
  whole review on Sonnet" (`sonnetSmallPrs`, on by default) replaces that
  rule with `SONNET_WORKFLOW_RULE` for a PR under the review limit
  (`isBigPr` false): the workflow's `model: "sonnet"` moves its context,
  synthesis and publish stages to Sonnet too (its `review-agent-sonnet`) —
  on 2026-11-25 a 54-line PR's review cost ~$8 on Opus, a dozen agents with
  the context stage alone at ~$2; `run/started` logs `workflowModel`),
  `agent-stream.ts` (a run's
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
  request is the author's "look again". A head gets one full re-review,
  not one per answer (#294 got two full runs, ~$2.2 each, on one commit
  five minutes apart): once a full review or re-review went over it — the
  agent's own or yours, running or ended prepared or published, by the
  ledger (`reviewedHead` in `PlanContext`, `reviewedHeads` in
  `main/agent/index.ts`; not a failed or dismissed run, nor one still
  waiting on you, whose card the next run replaces, nor a run over the
  threads only, which read none of the code; a "started" entry counts only
  while its run is still queued or working) — the author's next
  answer or request on that head is planned as a run over your threads
  only (`threadsOnly` on the job and the item). A light run planned while
  the full one still ran checks again as it starts (`fullyReviewed`: a full
  run of the head ended prepared or published) and runs full when none got
  through — the full one hit a usage limit or was stopped — logged as
  `widened` on its `run/started`. Its ledger key is the
  trigger's as before, so a full run's own trigger never comes back light.
  It runs the same skill with the skill's own `rereview: "threads-only"`
  and `statusComment: false` (`THREADS_ONLY_RULE` in the session's rules):
  your open threads checked against the head and the replies, none of the
  workflow's reviewers, no Blocker hunt on a head your review covers. The
  log says which in `run/queued` and `run/started` (`data.rereview`:
  `full` / `threads`, and the queued line's own words); the card says
  "Checking the author's answers in your threads", the chip "Checking
  threads on #N". A push is a new head, so a full re-review again; one you
  ask for is always full, while an interrupted run over the threads that
  starts over (`recoverInterrupted`) stays one. A review the agent published counts
  as yours in the plan, whatever its event (`agentReviewed` in `PlanContext`,
  from the ledger's published review and re-review keys, with the head the
  review went out on; `withAgentReview` puts its time and head in place of
  `viewerReviewedAt` / `viewerReviewedOid` while GitHub has no approval or
  change request of yours): GitHub's `viewerHasReviewed` reads
  `latestOpinionatedReviews` and never sees a plain "Comment", so every push
  to such a PR was a first review again, brief and all — six of each on one
  PR in a day. Now a new head gets a re-review of what changed, the
  base-only check compares with the agent's head, and a request that still
  stands on the very head the agent's review answered, with nothing from the
  author since, runs nothing. Only the plan reads it: the roles, `To review` /
  `Reviewed`, `isReviewDue` and `Hide my approvals` keep GitHub's answer. A
  Comment review of your own is not counted — `latestReviews` keeps one per
  reviewer, a reply in someone's thread is such a review too, and a plain
  question would shrink the whole review to a look at the latest changes. The
  agent writes no briefs: a review asked of you on a big PR starts its review
  straight away, and "Let the agent review" asks for the review itself. A
  brief was a second session over the same diff, and its questions for the
  author went into the review's prompt, so the review session checked them in
  the code itself beside its workflow — on the evening of 2026-11-25, $32 of
  briefs and $23 of that checking. A brief an older release left waiting
  closes when the PR's review is queued (`takeBrief`: its text onto the
  review's card, none of its questions into the prompt — `carry` is no longer
  read), and "Draft a review" on one no review followed starts a plain review.
  `scenarios.brief`, `runModels.brief` and the `triage` prompt stay in
  settings, unread, so an older build finds the shape it expects; Settings no
  longer shows them. The review limit (`isBigPr`) now only decides whether a
  small PR's whole workflow runs on Sonnet. A run the agent planned
  itself that fails (`fail`: a checkout the network refused, a crashed
  session) is tried once more by itself `RETRY_AFTER_MS` later (`retryAt`
  on the failed item, `dueRetry` in the plan; the new run carries
  `retryOf` and is not tried a third time) while the plan still wants that
  head — not a run you asked for, not one cut short again and again; the
  card, the toast and the PR's reason say when. A review or re-review the
  agent plans itself waits for the PR to settle first —
  authors and their own agents push every 10–30 minutes, and a day's log
  had a third of the runs review a head replaced during the run or right
  after it: `settlesUntil` in `planJobs` holds it until the PR has had no
  push, author's reply in a thread and review request (`reviewRequestedAt`,
  the latest `ReviewRequestedEvent`, of anyone — read in the hydrate) for
  Settings › Agent › Limits' `settleMinutes` (15; 0 is off). The push time
  falls back to the commit's date, so a time further ahead than the wait
  counts for nothing. The PR's reason then says until when
  (`SETTLING_WHY`), a job the ledger already has keeps the ledger's reason
  (`known`), and the plan's `wakeAt` — the first PR to settle — has the
  tick plan again then, since a quiet PR brings no new snapshot. A drive, an
  offer and a run you ask for never wait. And a review or re-review
  whose PR gets a new head while it runs is stopped at once
  (`stopMovedRuns`, on every tick, from the poller's latest read): the
  agent's own closes as superseded with `run/superseded` (what it cost, the
  head it read as `was`) and no toast; one you asked for starts over as
  asked on the new head, as after a restart (`recoverInterrupted`); a drive
  goes on — it commits on top — and so does a run going on with your
  answer. A PR's reason when it is
  idle comes from what the head's run really did (`ledgerIdle`): "Running"
  only while it is live, else how it ended, and every run's end plans
  again at once — except one taken over, cut short or ended by the
  switch-off — so no reason waits for the next poll. A drive's result
  from before the app last started is marked `needsRerun` at start: its
  push and its answer are checked against what the app took in memory
  (`pushTo`, never on disk). While its worktree is still there,
  `recoverDrives` (and a followed turn) rebuild `pushTo` from the clone's
  side — the worktree's git folder from `<commonDir>/worktrees/*/gitdir`,
  not the worktree's own `.git` file, the clone's push URL, a fingerprint
  taken now — only for the clone the app finds for the PR now
  (`trustedCheckout`, never `checkout` from state.json alone), only for a
  push URL that is the PR's repository, and refused while the
  repository's config could redirect a push or run a program for it
  (`redirectingKeys`: insteadOf, pushurl, credential/http/protocol keys,
  sshCommand, askPass, any include) — mark it `recovered` (pushed only on
  your click) and
  read the commits again, those your session made since included. What
  still can't be read becomes `localWork` (the folder and `rev-list`'s
  count on top of the PR): the card names it, never says "nothing to
  push", and Send is refused while it holds commits. Otherwise such a
  result is stale (`staleRun`): its question or Push could only be
  refused, so it is not your move — and neither is a drive's result once
  the PR's head moved past the commit it started from (`headMoved`, by
  `drive.base` or the key's head; a head that is one of its own commits
  is excepted, whether the app or a session continued in Claude pushed
  it). GitHub then places the card (With reviewers, Merge, Open on
  GitHub…), the run is the card's note, Discard is its obvious choice, the
  chip, tray and popover don't count it as ready (`AgentState.heads` gives
  them each PR's head), and it raises no toast (`agentNoticeTitle` is null). A drive's worktree is never removed with work you
  haven't seen (`keepForWork`: a HEAD that is not the one its card
  showed, changed tracked files, or a count git couldn't make) — Discard, a
  close and the sweep keep it and its run folder, write
  `refs/prd-agent/<runId>` (create-only, a UUID run id only), and say so on
  the card; the sweep frees it, ref and all, once that work is on the PR,
  and pruning skips such a card. Run again says so once first. Reading a
  worktree never goes through its own `.git` file (no git folder from the
  clone's side: nothing is read), and `git status` — which runs the
  config's clean filters — only while git's config matches the fingerprint
  taken before the session. A drive's replies are held once when they cite a commit id the
  PR doesn't have (`shasNotOnPr`), and a PR head that moved only by the
  run's own commits (the run's head under it, it under the worktree's
  HEAD) doesn't stop them. "Open in Claude" (`continue`)
  does not leave the card behind: a drive's or a review's card follows the
  session it resumed (`item.follow` in `state.json`, so a restart goes on
  following it) on the agent's own timer — a stat per tick, the transcript's
  tail read only once it changed and has been still for 2 s
  (`main/agent/followup.ts`). A turn that ends with a new `prd-result`
  block replaces the card's summary, questions and findings
  (`shared/agent-followup.ts`: the final message of the main conversation,
  not a subagent's, not a turn still going), and what is left is read
  again — the replies recorded through the run's wrapper, a drive's commits
  on top of the run's head (only while git's fingerprint still matches).
  Nothing asked and nothing left to send or push closes the card; a turn
  without the block changes nothing; a card that left Your move is no
  longer followed. A refused action's message shows
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
  The header's weather icon has its own: `weather.ts` (WMO weather code →
  one of seven kinds, and parsing Open-Meteo's geocoding and forecast answers;
  `main/weather.ts` fetches them for the city in Settings or, with no city,
  for the location saved by Settings' "Use my location" — the only things
  that leave the machine, so with neither nothing is sent and the header
  shows no weather at all (`WeatherBadge.tsx`: one static icon and the
  temperature beside the PR count) — and caches the answer 30 min, a failure
  5, keeping the last good answer through a failed refresh; the `weather:get`
  channel takes no argument, so the renderer cannot point the request
  elsewhere). Nothing asks for the location on its own: only that button
  does, over `weather:locate` (no argument — the coordinates come from the
  OS through main, never from the renderer), and they are kept rounded to
  ~1 km in `userData/weather-location.json` (`main/weather-location.ts`). Not
  `navigator.geolocation`: in Electron it calls Google's paid geolocation
  service and, with no API key, times out without a prompt.
  `main/locate.ts` asks the OS instead — on macOS the `prd-locate.app` helper
  (`native/macos-locate`, Swift/Core Location, built universal by
  `scripts/build-locate.mjs` into `dist/native` and shipped through
  `extraResources`), run with `open -n -g -W --stdout`, because Location
  Services prompts only for a bundle with a usage string and a bare child
  binary stays "not determined"; the hardened runtime needs
  `com.apple.security.personal-information.location`. On Windows it is
  GeoCoordinateWatcher in Windows PowerShell. Keep any such
  module Node-free — a `node:` import there breaks the renderer build (Vite fails
  to bundle it). A guard test in `tests/run-tests.cjs` asserts the compiled
  `notify.js`, `pr-filter.js`, `issue-key.js`, `hotkeys.js`, `pr-group.js`,
  `pr-table.js`, `view-mode.js`, `claude-launch.js`, `claude-sessions.js`,
  `settings-search.js`, `host-status.js`, `jira-status.js`, `stale.js`, `agent-defaults.js`, `agent-publish.js`,
  `agent-stream.js`, `agent-result.js`, `agent-view.js`, `agent-diagrams.js`,
  `agent-reapprove.js`, `agent-stack.js`, `agent-explain.js`, `approval-feedback.js`, `weather.js`, `ui-style.js` and `upsource.js` stay free of `node:` builtin references, so the
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
  second, never only a link — but never a button main would refuse: your PR
  from a fork (the agent never pushes to one) says how to fix it yourself, and
  a PR your own Claude session holds offers "Open your Claude session" first
  (`control: "session"`; the Board finds the session the way the card's Claude
  button does and switches to it). A review asked of you whose agent run on
  this very head ended with nothing to post and nothing that holds an approval
  back (`approvableReview` in `shared/agent-view.ts`: its own `prd-result`
  block, no Blocker, no Major, no question for the author) offers "Approve"
  first (`approve`, only the run id over IPC) and ranks with the other
  one-click moves. The run is the head's latest review whatever day it ended
  (`approvableRun`): the card otherwise reads today's runs only, so a review
  that ended yesterday on the same head left "Let the agent re-review" and no
  Approve; a later review of the head that posted, was cut short or that you
  discarded means none (one closed before it ever ran doesn't count). Later
  is by `startedAt`, since a Discard or an Approve stamps `finishedAt` again.
  Main checks the rule again,
  reads the PR again — open, same head, your approval not already on it — and
  posts an APPROVE of that head with one line and the signature, logged as
  `run/approved`; the run is then marked published, so it is offered once.
  Your PR approved with feedback in the approval's text
  (`hasUnaddressedReviewFeedback`, which keeps `canBeMerged` false until you
  put 👀 on that review) is Your turn, never "With reviewers": "Approved with
  feedback" lists each approval's points and offers "Mark as read 👀"
  (`markFeedbackRead`, only the PR id over IPC: main reads the PR again and
  puts EYES only on what the card showed — the snapshot's `reviewFeedback`,
  by review id and `updatedAt`; a review new or edited since refuses the
  whole click and the Board reads the PR again, since the 👀 says "I read
  this"; your 👀 from before a review's last edit is taken off first
  (`ackBeforeEdit`), as GitHub doesn't give a reaction twice; logged as
  `run/feedback-read`), "Let the agent address it" (`enqueue` with
  `feedback: true` — the only ask that adds the `feedback` reason,
  `askedDriveReasons`; Run again and a recovered run keep it only if they had
  it, and the plan never starts one by itself; always Shadow, since an
  approval's text is anyone's words; its own prompt, and rules that name only
  the approvals the card showed at the ask — kept on the item as
  `feedbackShown` and read back through `feedbackToRead`, so one that came
  or changed after the click is not its work; a run that changed nothing is
  the card's answer, not a failure — `isFeedbackOnly` / `answersReviewers`
  in `shared/agent-view.ts` say which runs those are) and the review on
  GitHub. Which text is feedback is `shared/approval-feedback.ts`
  (`readApproval`, Node-free): a plain yes, the app's own approvals (one of
  `APP_APPROVAL_LINES` first — the same source main posts them from — and
  nothing after it longer than a signature) and a creatio-code-review
  approval with a positive sign that it had no finding — no list item at all,
  folded or not, and either `mode=lenient` in its meta line (a lenient round
  raises only Blockers and never approves with one) or its own "approve (no
  findings)" — are clean. Every other text is feedback, a folded `<details>`
  included, and every list item of a creatio-code-review approval is a point
  (`note` when it names no severity), since nothing makes its publisher name
  one. Hidden comments are stripped in one indexOf pass and a body is read to
  GitHub's 65,536-character cap. `reviewFeedback` is in the poller's snapshot
  hash, so the card follows an edit. An approved PR of yours that still waits
  names what holds it (`approvedHold`) instead of "Waiting for reviewers", in
  the one order the agent's idle reason (`mergeBlocker`) names it too —
  `MERGE_HOLDS` in `shared/agent-view.ts`: CI running, a reviewer or team,
  the feedback (never on that card: such a PR is Your turn), a required
  review, behind base, open threads (the card only; for the agent the
  threads setting decides), or GitHub not calling it mergeable yet.
  Every Your-turn card has "Not now" (`notNow`,
  only the PR id goes over IPC): main stores the card's `cardKey` — the PR's
  head, `updatedAt`, CI and conflict state, and its latest run — in
  `state.json` (`setAside`), and while that still reads the same the card
  sits folded under "Set aside" and out of every "ready for you" count
  (`readyItems`, `hiddenReady`). Main sets aside only a card in Your turn,
  and one rule (`stillAside`) says a card is still aside: its PR on the
  dashboard, the same key, the card still in Your turn. Anything new on the
  PR ends it — `getState` filters at once, and every snapshot prunes and
  tells the window, the agent on or off — or Bring back (`bringBack`) now. The two lanes are a tag on each card, not rows
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

## Repository skills (Claude and Codex)

Keep repository skills in `.claude/skills/<name>/SKILL.md`. The tracked relative
symlink `.agents/skills` → `../.claude/skills` exposes that same directory to
Codex's repository skill discovery, including newly added skills. Edit the
canonical Claude directory; do not copy skills or replace the symlink with a
separate directory. Skill resources and scripts stay beside their `SKILL.md`.

## Build / run

- `npm run dev` — Vite dev server (HMR) + Electron pointed at it. The main
  process compiles in `tsc --watch` and Electron restarts after each clean
  build: it reads `dist/main` only at startup, so a one-off compile kept a dev
  app on stale main code while the renderer hot-reloaded and looked current.
- **A build that isn't the installed app has its own data folder**,
  `<userData> (dev)` (`main/dev-user-data.ts`, set at the top of `main.ts`
  before the single-instance lock): one run from source (`!app.isPackaged`) or
  from a packaging folder — on Windows a packaged exe with no
  `Uninstall PR Dashboard.exe` next to it is a `dist/win-unpacked` build
  (`isInstalledBuild`). All of them are named "PR Dashboard", so every
  worktree's build used to read and write the installed app's `settings.json`
  and agent state: a branch with a reshaped setting saved it in its shape, and
  the release the next auto-update restarted read it as defaults — "settings
  reset on every update". Such a build also leaves the launch-at-login entry
  alone (Windows writes it with the running exe's path, so the next sign-in
  started a worktree's old build) and takes no updates (`win-unpacked` ships
  `app-update.yml`, and its update would run the real installer). The first
  launch copies `settings.json` (agent switched **off**), seen, ignored,
  window and weather-location state from the installed app, once — never the
  Jira token, whose key on Windows lives in the folder's own Chromium state.
  It no longer shares the installed app's single-instance lock, so both can
  run at once: two pollers, two sets of toasts, and two agents on the same PRs
  if you switch its agent on. Delete the `(dev)` folder's `settings.json` to
  seed it again. macOS has no such check: a `dist/mac*` app counts as
  installed.
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
  (`menu:open-settings`, `menu:refresh`, `menu:find`) because the renderer owns
  the view and the loading state. View › Search (CmdOrCtrl+F) focuses and selects
  the search box of the screen on view — the PR list's or Settings', each marked
  `data-find-field`. Both actions surface the window first (`createMenuActions`,
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
- **A save never erases a field another build wrote.** Loading reads a field
  this build doesn't know as nothing, so `persistSettings` merges the file on
  disk back in (`keepUnknownSettings` in `shared/config.ts`): every field
  outside this build's known shape — the defaults plus the optional fields in
  `OPTIONAL_SETTINGS_SHAPE` — is kept at any depth, while a known one always
  comes from the save, so a cleared Jira site, Upsource address or removed
  repo path stays gone (an empty object in the shape, like `claude.repoPaths`,
  is a map owned whole; arrays too). A known field whose value this build
  rejects is not kept: validation turns it into the default, and the save
  writes that default (a newer build's `uiStyle` is lost to an older one's
  theme toggle). `OPTIONAL_SETTINGS_SHAPE` is typed against `Settings`, so a
  new optional top-level field, or a new key of `jira`/`upsource`, fails the
  build until it is listed — unlisted, clearing it in Settings would bring it
  back from disk. Renaming or reshaping a field therefore needs both
  directions: read the old key, and expect an older build to keep writing it.
  A field removed on purpose — a moved secret — goes in
  `RETIRED_SETTINGS_FIELDS`, or the merge keeps it alive.
- **Only a missing `settings.json` is the first run.** `readSettingsText`
  (`main/settings.ts`) returns empty settings for ENOENT alone; a read that
  fails otherwise is tried again a few times (EBUSY/EPERM/EACCES/EAGAIN — a
  scan or an installer holding it), then throws `ConfigError`, which the
  poller and the UI show as an error. The retries sleep on the main thread and
  `loadSettings` runs on every poll tick, so a transient error that outlasted
  them is remembered for a few seconds (`READ_FAILURE_MEMO_MS`): calls in that
  time throw at once, with no retry (a Save's read-before-write reads anyway),
  and each failure is logged once until a read succeeds. A start that cannot
  read them runs on the defaults but leaves the OS login item as it is. It
  used to read as "no
  file", so a file that was there but unreadable looked like a first run, and
  the next save wrote defaults over it. So `persistSettings` refuses to write
  over a file it could not read, writes through a temporary file renamed over
  the old one — the rename retried like a read, since a scanner opens the file
  it just saw written; one that still fails removes the temporary file and
  throws `ConfigError`, the old settings intact — and `App.tsx` reads the
  config again once a snapshot polled hosts the config doesn't list
  (`configLooksStale` in `shared/host-status.ts`; it was read once on mount
  and never again). `userData/main.log`
  (`main/diag-log.ts`, capped, `.old` kept) records each start — version,
  argv, data folder, how many hosts and whether the agent loaded — every
  failed settings read and the updater's downloads and errors (one line each;
  an error's stack is in `userData/updater.log`): read it first when settings
  "reset" again.
- **A packaged app's copy of the data folder** (Windows, `main/data-copy.ts`).
  A process started from an MSIX app keeps that app's view of `%APPDATA%`.
  Claude Desktop's terminal and sessions are such processes: their writes land
  in `%LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\PR Dashboard`,
  and their reads show that copy over the real folder.
  `GetCurrentPackageFullName` still says "not packaged", so nothing in the
  process tells it apart.
  - **The story behind "settings reset after every update".** The settings
    one user had saved since a start from Claude lived in Claude's copy. The
    app started from the Start menu, the desktop, the login entry or an
    update's relaunch (`ExecShellAsUser`, through Explorer) read the real,
    nearly empty folder. The same exe and file read fine from the shell,
    because the shell itself sits inside Claude's view.
  - **What the app does.** At start, `findDataCopies` looks for
    `Packages\*\LocalCache\Roaming\<userData's name>` holding a
    `settings.json`. It logs each copy to `main.log` and calls a copy
    `inside` when the data folder's `settings.json` opens the same file, or
    `outside` when it opens another one. The banner (`DataCopyBanner`, over
    `app:dataCopy`) says why settings look reset: inside, start the app from
    the Start menu; outside, the copy holds what was saved there.
    `app:showDataCopy` opens only the folder main found and takes no
    argument. In the plain-browser mock, `?dataCopy=inside|outside` previews
    the banner.
  - **How to see the real folder from a Claude session.** Run the command
    through `explorer.exe <script>.cmd`. A test of the installed app with the
    real profile must not start it from a session.
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
- Launch at login starts the app **in the tray** when close-to-tray is on —
  **on macOS only** (`startsInTray` in `main/login-launch.ts`; macOS relies on
  `wasOpenedAtLogin`, best-effort — login items there take no arguments). On
  Windows the window opens at sign-in: Windows 11 puts a new tray icon behind
  `^`, so a tray start looked like the app had not started, and the Run-key
  entry is now the plain exe (an older build's `--hidden` entry is rewritten
  on the next start and ignored until then). A tray start creates the first
  window with `show: false`, and it is
  shown anyway if the tray icon failed to appear, since a hidden window with no
  icon is unreachable. The saved maximized/full-screen state waits for the
  first `show`, because `maximize()` would itself show the hidden window.
  The Run-key value is named after the AppUserModelID, so a build that ran
  before `setAppUserModelId` left an `electron.app.PR Dashboard` value behind
  and the app started twice at sign-in, once without `--hidden`;
  `staleLoginItemsFor` deletes it on every apply, whatever the preference is.
- **An update installs silently and starts the app again**
  (`quitAndInstall(true, true)` in `main/updater.ts`, 3 s after the download).
  The Windows installer is the assisted one (`oneClick: false`), and its NSIS
  templates start the app after an update only when silent (`isForceRun` *and*
  `Silent` in `installSection.nsh`); a plain `quitAndInstall()` quit the app
  and left the wizard waiting for clicks — an update downloaded at night kept
  the app closed until morning, its Finish page the only way back. Silent, the
  installer takes the install mode and folder from the previous install's
  registry entry (`initMultiUser` in `assistedInstaller.nsh`) and starts the
  app through the Start menu shortcut, with its window shown.
- `PRD_DEBUG=1` enables main-process diagnostics; `PRD_SMOKE_EXIT_MS=<ms>` makes
  `electron .` self-quit after the renderer loads (a non-interactive boot check).
- **The PR agent's log** is `userData/agent/log.jsonl` — one JSON line per
  event, kept for Settings › Agent › Policy's retention (its "Show the log"
  opens the folder). Read it first when the agent did something odd. Every line
  has `at`, `kind`, `event`; most have `prId`/`prNumber`/`repo`/`runId`, a
  change has `from`/`to` and `ms` (how long the `from` side lasted), the rest is
  in `data`. Kinds: `run` (a run's own steps — `queued` with mode, reasons and
  PR size; `started` with its folder, the model and effort it was started
  with (`reviewerModel` when its reviewers went to Sonnet) and queue wait; its end,
  `needsYou`/`done`/`failed`, with time, turns, cost, tokens, tool calls,
  refused tools and stderr's tail; `interrupted` when its process was ended
  under it; `superseded` when the PR got a new head under it, with the same
  stats and the head it read (`was`); `diagrams`; `published`/`pushed`/`merged`/`reapproved`/`reasked`
  and their `not-*` refusals; `approved-again` (no run: your Approve again);
  `feedback-read` (no run: your Mark as read put 👀 on approvals with feedback);
  `approved` (your Approve on a review that found nothing blocking);
  `offered` for an offer; `notice`), `item` (every
  state change of an item), `board`
  (a card's column or button changed: `seen` on the first look, `move`,
  `action`, `left`), `plan` (why the agent leaves a PR alone — `idle` — what
  holds the queue — `held`/`released`, the usage hold below included, and
  `usage-released` when your Try now or Resume let go of it — what a head's re-approve check
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
- **The agent's share of your Claude usage** (Settings › Agent › Limits). You
  work in Claude yourself, so the agent must not spend the whole window. Every
  run's stream-json carries `rate_limit_event`s (`readUsage` in
  `shared/agent-stream.ts`): `status` (`allowed` / `allowed_warning` /
  `rejected`), `resetsAt` and `rateLimitType` of the window that limits now,
  and `unifiedWindows` — `five_hour` (the session) and `seven_day` (weekly),
  each `{ utilization, resetsAt }`, `utilization` a fraction that may pass 1 —
  sent whenever a window's rounded percentage moves (absent for an API key).
  `usageHold` turns a reading into a hold: `rejected` until its reset, or a
  window at `limits.usageCap` percent or more (default 80, 0 off) until that
  window resets; `allowed_warning` alone never holds — it comes at Claude
  Code's own thresholds (75% of the week), and holding on it stopped every run
  for days. Runs in flight finish, so the cap is overshot by what they still
  spend — the reason `limits.parallel` stops at 5. A run refused by the limit
  ends with Claude Code's line, "You've hit your session limit · resets 9:50pm
  (Europe/Kyiv)" (a date past a day: "Nov 28, 10am", a year past New Year), in
  the result's text with `is_error` and `subtype: "success"`;
  `limitResetFromText` reads it in that zone, and the stream's own `rejected`
  reading wins when there is one. Only that error result is read, never the
  model's words: a PR can make a session write the line, and a hold stops
  every run — so the line must be the whole text, its year this one or the
  next, and no hold lasts past `MAX_USAGE_HOLD_MS` (8 days). Such a run is no
  failure card: it is `interrupted` (`usageRefused`, not counted as a cut —
  the hold keeps it from hitting the wall again), put back in line by the
  plan at once and `resumed` in its own session when the hold ends, like a
  run a restart cut short (a drive starts over); a failure with a `retryAt`
  only ran into the same wall. It goes on with `LIMIT_RESUME_PROMPT` (`afterLimit`
  set at the requeue), which also tells it to start its review workflow
  again with `resumeFromRunId` — the `wf_…` its launch printed under
  "Transcript dir" — so the agents that finished come from the workflow's
  own cache instead of running again. The hold is `usageHold` in `state.json`, not
  memory — a restart used to start the queue straight into the limit — and
  holds every run, asked or not; a cap hold keeps the share it was set at
  (`usage`) and lets go once the cap is raised past it. A limit raised or
  reset sends no reading, so your Try now (on the Board and the popover) or
  Resume lets go of any hold early (`releaseUsageHold`, logged
  `usage-released`): one run goes first (`usageProbe`) and the rest wait
  until Claude lets it through — a reading that holds nothing, or a tool
  call — so a limit that still holds costs one run, not one per parallel
  slot, and its reading brings the hold back. `limits.costPerDay`
  (0 off, the default) holds new runs once the runs ended on the local day
  cost that many dollars at API prices (`costToday`: each run's
  `total_cost_usd` plus its diagrams' — on a subscription a measure of usage,
  not a bill), counted like `perDay`. `AgentState` carries `heldUntil` /
  `heldWhy` and `costToday` / `costPerDay`, and `agentSummary` words them once
  for the Board, the chip, the popover and the tray ("Claude's weekly usage at
  82% (agent cap 80%) — waits until Fri 10:00", "Daily budget reached ($20.40
  of $20)").
- **Upsource reviews** (Settings › Integrations › Upsource, `Settings.upsource`)
  join the list as items of their own: `shared/upsource.ts` (Node-free) maps
  each open review you wrote or review into a `PullRequest` with
  `source: "upsource"` and the review itself in `pr.upsource`, so grouping by
  Jira key, search, the role and author filters, sorting, seen-state and
  ignoring work on it unchanged. Its GitHub fields hold neutral values (no CI,
  `canBeMerged` false, no stack), and the card, tile and Cozy row read
  `pr.upsource` (`UpsourceCard.tsx`); the copy, ignore, Jira-key and avatar
  controls both kinds of card carry live once, in `components/card-controls.tsx`.
  `main/upsource.ts` keeps the Hub permanent token encrypted like Jira's
  (`userData/upsource-token.enc`; a token with spaces or line breaks is refused
  before it is stored) and is the poller's `upsource` source:
  `getCurrentUser` (a guest answer is a refused token), `getReviews` (paged),
  `getUserInfo` over `POST <base>/~rpc/<method>` with `Authorization: Bearer`
  — https only, in settings and again before every call, one deadline per
  call that covers the body and one for the whole read, and an error before
  any answer names only its code, never the request. The source reads **in
  the background**, one read at a time, at most once per poll interval, the
  last list kept through a failure (the server is internal: off the VPN it is
  unreachable). The poller never waits for it: every tick that is not parked
  kicks it (forced on a manual refresh) and takes `current()` as it is, its
  `nextDueAt()` counts toward the tick's wake-up (so it is read on time with
  idle GitHub hosts or none at all), and a finished read calls
  `rebuildSnapshot()`, which runs once more after a tick in flight rather
  than joining it. `upsource:setToken` kicks a forced read itself — a read
  started with the old token is dropped and the new one follows — and does
  not wait for it (Settings closes only on its reply).
  The host pill "Upsource" comes from `toPublicConfig` and gets a no-budget
  reading (`resetAt` empty) for its green dot. Nothing GitHub-only may see a
  review: the agent and every GitHub action in `main.ts` read `githubSnapshot()`
  (`githubOnly`), the Board drops reviews, and `groupLaunchPrs` skips them, so
  "Explain all" / "Review all" never hand Claude an Upsource link.
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
  wrapper subcommand, and a folder list keeps absolute paths only (the run's
  `allowedTools` there feed refusal hints alone, never a decision, so a bad
  entry is dropped rather than refused) — and
  follows a drive's write through links (`checkRealWrite`): `checkDriveWrite`
  alone is lexical, and a link committed in the branch would lead it out of
  the worktree. A merge
  keeps the branch while open PRs build on it (`builtOn` in
  `main/agent/merge.ts`): gh's own delete can win the race with GitHub's
  retargeting and close them.
- **A repository with no checkout of yours is cloned by the agent**
  (Settings › Agent › "Clone a repository it has no checkout of", on by
  default; `main/agent/clones.ts`) rather than left with "No checkout": into
  `userData/agent/clones/<host>/<owner>/<repo>`, never your folders —
  blobless, one branch, no tags, no working tree, made under a `.partial`
  name and renamed when complete, one clone in the making per repository.
  The clone signs in through gh like the rest of the app: its own config
  resets the credential helpers and names `gh auth git-credential`, so a
  later fetch, a run's worktree and a drive's push use gh's token for that
  host and no credential manager opens a window behind the app. A plan does
  not wait on a missing checkout while cloning is on; the run clones after it
  holds its slot (a clone can take minutes). A drive's session has no
  network and a blobless clone lacks old file contents, so before a drive in
  such a clone the app runs the base diffs and the merge of the base
  (`prefetchForDrive`) and git fetches what they read. With the setting off,
  the PR waits with a reason that starts `NO_CHECKOUT_WHY`
  (`shared/agent-view.ts`), and every Board button that starts a run asks
  instead: "Clone and review" (re-review, fix, self-review; "Clone and try
  again" on a failed run) sends `enqueue` with `clone: true` — a yes, never
  a URL or a folder — and the run carries it as `item.clone`, kept by Run
  again and by a run the app's closing cut short while it cloned
  (`recoverInterrupted`). Which PRs lack a checkout comes from main as
  `AgentState.noCheckout`, worked out each plan only while the setting is
  off: the plan's idle reason reaches Your turn only, and "Re-review now" /
  "Self-review again" in the waiting column were refused for it. It is a yes
  for that one repository: the clone is the agent's own and stays, so later
  plans find it with the setting still off. While a run clones, its card
  says "Cloning <repo> first". A run that finds no checkout gets no
  `retryAt`: the plan holds such a PR back, so the try would never come. The clone and all
  git work in it — a run's worktree, a drive's base fetch and prefetch, the
  re-approve and base-only checks (`gitFor`) — run under `runGitLong`
  (30 min, not `runGit`'s 2): a large repository over a slow VPN would
  otherwise be cut short at the same point on every plan. Nothing cancels
  such a git yet, so switching the agent off lets it finish. The re-approve and base-only checks
  use an agent clone that is already there but never make one: they take no
  run slot, so a plan would start a clone per repository at once. The clone
  is a trusted checkout (`trustedCheckout` takes your folder or the agent's
  clone, whichever the run used), and a
  drive's push place is rebuilt after a restart there too: `recoverPushTo`
  lets `redirectingKeys` pass `credential.helper` from the clone's own
  config (compared by real path) only while its values are exactly the pair
  `cloneCommands` wrote (an empty reset, then gh's) — any other helper there
  is still a redirect.
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
  refused. `--restricted` refused that folder on its own (the session
  reading its Workflow's `journal.jsonl` to see why it stopped), so a
  restricted run also passes it with `--add-dir` (`sessionFolders`:
  `<root>/<projectDirName(cwd)>/<sessionId>`, made in advance — this
  session's only, never a root). `~`, `..`, a colon past the drive letter and an absolute Glob
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
  One exception is narrow on purpose: the review skill's preflight. Its
  Workflow first runs a deterministic helper of the installed plugin
  (`skills/creatio-code-review/scripts/rereview-context.cjs`), found through
  Claude Code's `plugins/installed_plugins.json`; the helper writes the PR's
  data to `<tmp>/creatio-rereview-payload-*`, which later agents read. When
  a mounted plugin carries the helper, a review or re-review with a payload
  folder gets `preflight` in its guard file (`preflightFor` in
  `main/agent/runner.ts`), `Bash(node *)` and a temp folder of its own
  (`runTempEnv`: `<runDir>/tmp` as `TEMP`/`TMP`/`TMPDIR`), and
  `checkPreflight` / `preflightReadable` allow exactly: reading that one
  JSON file, reading inside a payload folder right under the run's temp
  folder, `node <helper> < <request file in the run's payload folder>` and
  `node <helper> --digest <payload folder>` — paths followed through links,
  any other `node` call refused. The helper runs `gh` with your login on
  whatever PR the request names, so the request is held to the run's own PR
  and the four keys the skill sends (`requestProblem`). `node` never reads
  the session's own file, which it could rewrite or rename over after the
  check: the hook copies the checked text into `<runDir>/requests`, where
  the session writes nothing (`requestStore`), and hands Claude Code the
  command rewritten to read that copy (`updatedInput`), allowed by the hook
  itself (`permissionDecision: "allow"`): the guard built all of that
  command, and the copy is outside the session's folders, so Claude Code
  would otherwise ask for an approval a headless run can't give — and the
  review would abort. Nothing is locked, so a
  refused request can be corrected and run again. The temp folder is the run's own because
  your shared one keeps the payloads of every other review of the last day.
  Without this every review aborted at the preflight (`preflight-unverified`)
  and was reported as "Reviewed — nothing to post".
- **A refused call is a wasted step, so the rules say what works first and a
  refusal says what to do instead.** Each refusal costs a step that re-reads
  the whole context (2026-11-25: 469 refused calls in 68 runs, ~16% of the
  main sessions' context tokens). `sessionToolRules`
  (`shared/agent-guard.ts`, appended by `agentRules` to a restricted run's
  system prompt from its own `--allowedTools` and the workflows its prompt
  names) says up front: one plain command per call, which programs a
  read-only run's Bash runs, Read/Glob/Grep instead of `ls`/`cat`/`grep`,
  the `gh` reads that replace git — only commands both the guard and the
  run's tools let through (`ruleAllows`; a test runs each through
  `checkBash`) — `twg -o json`, reading a spilled result rather than running
  the command again, the publish wrapper's usage (`PUBLISH_USAGE`: never
  `--help`, never read; it posts no status comment, so `statusComment:
  false`), and each skill workflow by its script path. That last one is why
  every review's first Workflow call said `not found. Available:
  deep-research`: the creatio-code-review skill says to start its workflow
  by name, a name its installer copies into `~/.claude/workflows`, which
  `--restricted` doesn't load — and the guard refuses names anyway
  (`checkWorkflow`). `skillWorkflows` (`main/agent/plugins.ts`) finds the
  `*.workflow.js` of the skills the prompt names. A Workflow's own agents
  don't get the rules, so every refusal carries its hint too
  (`readOnlyRefusal`, `refusedSyntax`, and the git, gh, wrapper, read and
  preflight-request refusals). Hints only explain: no decision depends on
  them, and the tests assert each hinted call stays refused — add a hint
  where the refusal is, never an allow. The rules ride on every step of
  every run: keep them short.
- **A session waits for its workflow by ending its turn, never by looking.**
  `claude -p` stays alive for background workflows and hands their result
  back as a new turn, yet sessions checked on theirs — the PR's timeline,
  a Glob of the payload folder — up to 98 times in one run, each look
  re-reading the whole context: on 2026-11-25 such waiting was 1,006 calls,
  ~23% of what the reviews cost, and one review spent $18 waiting on a $11
  workflow. `WORKFLOW_WAIT_RULE` (in `sessionToolRules`) says to end the turn
  once the workflow is launched, with no review of its own beside it, and
  that nothing the wrapper records shows on GitHub before the session ends.
  The guard backs it: in a read-only run, the same call by the same agent
  more than `REPEAT_LIMIT` (3) times in a row — the file tools and
  `gh`/`twg` reads, keyed by `repeatKey` with the hook input's `agent_id`
  (absent for the session itself; a workflow's agents are subagents with ids
  of their own, so its reviewers each reading the diff is no repeat) — is
  refused, with `repeatRefusal` telling it to end its turn. Only in a row:
  any other call in between starts the count over, so a re-read after other
  work or a retry after a failed `gh` is never held against it, and that
  day's loops were still caught (104 of 118 and 78 of 94 repeated looks).
  The count is one small file per agent in the run's `repeats` folder beside
  the guard file (`countInARow` in `main/agent/hook.ts`: the last call's hash
  and its run length, written through a renamed temporary file; missing or
  broken reads as a first call), cleared when the run starts; best effort, it
  only ever refuses. Not in a drive, where the same `git diff` rightly
  answers anew after an edit, and never the wrapper's writes or the
  preflight's node.
- **A review's own session only orchestrates its skill's workflow.** When the
  review or re-review prompt's skill has exactly one `*.workflow.js`
  (`skillWorkflows`; a full-context drive never), the session is told the
  whole call — `Workflow({ scriptPath, args })`, the args the app knows
  (`reviewWorkflowArgs`: the PR, `dryRun`, the wrapper as `publishCommand`,
  `statusComment: false`, `rereview: "threads-only"` for a run over the
  threads, `model`/`reviewerModel` for the Sonnet options) — and nothing
  else to do first: `orchestratorRules` replaces the plan, tool and Sonnet
  rules, so it starts the workflow, ends its turn, and once the result comes
  back finishes a re-review's thread work through the wrapper and writes the
  prd-result. The guard file then says `orchestrator: true`, and the hook
  holds the session itself (no `agent_id`; a workflow's agents come with one,
  `agent_type: "workflow-subagent"` — checked against claude 2.1.270) to it:
  `checkOrchestratorUse` refuses its reads of the PR's worktree, every
  Grep/Glob/LS, the Agent tool and any Bash but the wrapper and
  `gh api user`; and while the workflow it launched in this turn runs
  (`workflowLaunchedThisTurn`, from the hook input's `transcript_path` —
  only the run's own `<sessionId>.jsonl` — and `prompt_id`) every call is
  refused with `WORKFLOW_RUNNING_REFUSAL`. That needs no timer and no guess:
  a workflow's result comes only as a new prompt (`origin.kind:
  "task-notification"`) after the session ends its turn, so no call in the
  launching turn can see it — the 159 looks of #304's review were all in
  that turn. A launch that failed or was refused, or a later turn (a resume
  after a restart or the usage limit, which may start it again), holds
  nothing. Claude Code writes the transcript as it goes, so a call made in
  the very instant of the launch can slip past the hold; it still meets
  `checkOrchestratorUse`. On the evening of 2026-11-25 the sessions around the
  workflow were a third of the cost: $23 checking a brief's questions in the
  code beside the workflow, $20 waiting by looking ($15 of it in one review).
- **The computer's sleep doesn't end a run.** On 2026-11-26 six runs started
  in a short wake from Modern Standby, froze with the system, and were all
  "Stopped after 120 min" at the next wake — two hours of sleep and a few
  minutes of work, their reviews thrown away. A run's time limit is an
  `awakeDeadline` (`main/agent/runner.ts`): a step every 30 s counts at most
  two steps, so a frozen stretch adds one step, not its length. And while a
  run works on mains power, `main.ts` holds a `powerSaveBlocker`
  (`prevent-app-suspension`; Settings › Agent › "Keep the computer awake
  while a run works", `keepAwake`, on by default), released once no run
  works, on battery or with the setting off. The decision is
  `createKeepAwake` (`main/keep-awake.ts`, unit-tested with its calls
  injected): the setting is read only while a run works on mains power, at
  most once per `KEEP_AWAKE_SETTING_TTL_MS` (30 s) — the agent pushes its
  state every quarter second — so turning it off mid-run takes hold within
  that, and one that can't be read is off. Modern
  Standby may still sleep on a lid or power button — the awake deadline is
  what keeps such a run. `main.log` records each system suspend (with the
  runs working) and resume.
- **Except a drive on your own PR, with full context** (Settings › Agent ›
  "Your PRs: full context", `permissions.fullContextDrive`, on by default).
  Its diff and comments are yours and your reviewers', so it runs with your
  own Claude setup: `RunSpec.isolation: "full"` drops `--restricted`,
  `--strict-mcp-config` and `--tools` (your settings, permission mode,
  CLAUDE.md, hooks, plugins and MCP servers load; the drive's `--allowedTools`
  only add to yours; only the `prd-user-skills` plugin is mounted on top), and
  the guard file says `mode: "full"`, with no `readDirs`. `checkFullToolUse`
  then turns into a denylist of writes to GitHub — `git push` (also through
  `sudo`/`env`/`sh -c`, a `$(…)`, a `-c alias.`), `gh pr|issue|repo|label|…`
  writes, `gh api` with a non-GET method, fields (but a GraphQL query) or
  `--input`, and any tool of a GitHub/GHE MCP server but its reads — and
  `checkRealWrite` lets writes land anywhere. This is best-effort against a
  model that forgets the rule, not against a script that hides the call; the
  hard boundary is still `sessionGitEnv` (no credentials, every remote
  rewritten), and the app still pushes and posts the replies itself. Reviews,
  briefs, re-reviews and the after-merge run never run full.
- **The look** (Settings › Appearance › Style, `Settings.uiStyle`): `flat`
  (the default), `neumorphism`, `claymorphism`, `neobrutalism`, `bento`,
  `glassmorphism`, `terminal`, `paper` or `creatio` — one list in `shared/ui-style.ts` (`UI_STYLES`, Node-free,
  read by settings validation, the IPC check, the Settings menu and the
  renderer) — a second axis next to
  light/dark, so each works with both themes. The renderer sets
  `data-ui="<style>"` on `<html>` (none for flat; `renderer/src/ui-style.ts`,
  also cached in localStorage so a restart does not flash the flat look) and
  `styles.css` keys every rule on it. Neumorphism: canvas and surface one
  colour, cards, panels and framed buttons raised by a light and a dark
  shadow, fields and segmented wells pressed in. Claymorphism: a pastel
  canvas, lighter cards with big radii puffed up by a drop shadow and two
  inner shadows, buttons as small clay pills, the chosen segment a pastel
  accent. Neobrutalism: a loud canvas, thick ink outlines and hard offset
  shadows with no blur, buttons that drop onto their shadow when pressed, the
  chosen segment a bright yellow (its children inherit the dark text, or a
  count with its own colour class vanishes on it in the dark theme), and a
  near-white ink in the dark theme. Bento grid: borderless cells with big radii,
  and in the card grids (`data-pr-grid` on `PrList`'s two grids) every fifth
  card / seventh tile spans two columns with dense packing — Roomy's only
  from `md`, where it has two columns, or the span would invent one.
  Glassmorphism: a fixed backdrop of soft colour blobs and
  translucent cards, panels and the table with a backdrop blur. The blobs
  (a fixed `.glass-backdrop` layer) drift slowly, but in steps:
  `renderer/src/glass-drift.ts` moves them a few pixels once a second through
  custom properties on that layer alone, stopped while the window is hidden or
  reduced motion is on — a CSS animation would re-blur every card each frame.
  Their path runs on the drift's own clock, not the wall clock: it advances
  only while they move and is kept in localStorage (`prd:glass-drift-ms`), so
  a hidden window or a restart resumes exactly where they stopped; only a
  switch to Glassmorphism from another look (`applyUiStyle`) starts it over.
  Every split button (`data-split`: the Claude button and the group
  heading's) keeps the inner corners of its two halves square in every look,
  since each look's frame rule rounds every button on all four corners.
  The table's sticky actions column takes no fill (any fill or second blur
  showed as a lighter stripe). Terminal: a monospace TUI — every corner
  square but the avatars', single-line boxes, no shadows, what is on or
  chosen in inverse video, double-line menus and dialogs; dark is phosphor
  green with scanlines as a static background image on `body`. The font
  makes text wider than the other looks', so the Cozy columns truncate
  sooner. Paper: Notion-like warm greys, serif headings (`h1`–`h3` only),
  framed buttons as ghost buttons with a grey hover, grey wells for fields
  and segmented controls, and the Cozy table with rules between its columns.
  Creatio: Creatio Freedom UI's language — Montserrat (bundled,
  `@fontsource-variable/montserrat`, imported in `main.tsx`; its faces load
  only once a rule names the family), navy text, the violet wallpaper as
  `body`'s background framing `#root > div` as a rounded workspace,
  frameless toolbar buttons with a light-blue hover, segmented controls as
  uppercase tabs with an orange-red underline, underline-only fields. The
  status colours (stripe, pills, the fuchsia "Needs you") stay Tailwind's in
  every look. The rules sit outside Tailwind's layers so they beat the
  utilities; a new card or panel that should take part needs `shadow-tile`
  or the `rounded-xl border border-line` panel shape. The switch applies at
  once and persists over `style:set`, like the theme. In the plain-browser
  mock, `?ui=<style>` previews them (with `&buddy=review` for nine PRs, enough to
  see the bento grid). After an update the styles are offered once in place
  (`StyleOffer.tsx`, `?styleOffer=1` in the mock): each button applies its look
  at once and the card stays open; closing it ends the offer for good. It
  appears only once the app takes clicks (`waitUntilResponsive` in
  `App.tsx`: past the first snapshot, three quick round trips to main and
  window timers in a row — a timer, not a frame: rAF follows the frame rate,
  which a window that is not in front can lower) — a start keeps main busy for seconds, and on
  macOS every click goes through main, so a card shown at once ignored them.
  `shared/style-offer.ts` decides at start, before "What's new" is seeded —
  no What's new record means a fresh install, settled as done — and the record
  lives in `userData/style-offer.json`, not in `whats-new.json` (rewritten
  whole per version) or `settings.json`.
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
  blink per snapshot), `.claude-glow` (three breaths of a PR card's corner
  glow when a Claude session on it starts working) and `.claude-attention`
  (a session waiting for you: a fuchsia wash over the whole tile and a ring
  that is the tile's own outline, `data-needs-you` — an inset ring followed
  the frame's inner corners, which the thick accent edge skews — both lit); only their own layer's `opacity` animates, so
  nothing repaints per frame. **The one exception that runs on** is that
  tile's size pulse (`startPulse` in `ClaudeButton.tsx`, a transform-only Web
  Animation with `iterations: Infinity`): it pulses until a click in the tile
  answers it (`needs-you.ts`, per session, cleared once it stops waiting) and
  runs whether or not the window has focus — a window beside the app you work
  in is where it is for — but is paused while the page is hidden (in the
  tray, minimized), so it never draws for nobody. The tile scales about the centre of its Claude button and the
  button scales back by the inverse, so "Needs you" stays still and easy to
  hit. A test pins the pause; the guard scan below cannot see a Web
  Animation, so a new one needs the same gate. Which PRs ask for you is one
  rule, `renderer/src/needs-you.ts` (the shown session waits and its tile
  wasn't clicked since); while such a tile is out of sight — scrolled away
  or in a collapsed group — `NeedsYouPill` shows "✋ N need you ↓" and a
  folded group's heading a fuchsia count, both pulsing in size the same way
  (`usePulse`, same gate). Nothing scrolls by itself (with
  several such tiles it would jump between them): a click on the pill goes
  to the nearest one, below first, opening its group if folded. Key it on something monotonic per event: `App.tsx` uses a
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
  animations under it short and finite. A JS timer that restyles a layer under
  a `backdrop-filter` is an animation under this rule too, though the guard
  test cannot see it. The one allowed exception is `glass-drift.ts`
  (Glassmorphism's backdrop): about one step a second, only while the document
  is visible, and off under reduced motion — a new one needs the same
  justification, not a `setInterval` in place of a CSS animation.

## Windows release signing

GitHub Actions Release signs Windows builds using `WIN_CSC_LINK` (base64 PFX)
and `WIN_CSC_KEY_PASSWORD` secrets. `forceCodeSigning` is required in CI. Before
upload, `scripts/verify-windows-release.ps1` checks the app and installer against
`build/windows-signing/PR-Dashboard.cer`, checks timestamps and updater publisher
verification, then stages dash-named assets with `WINDOWS-TRUST.md` and
`Install-PR-Dashboard-Trust.ps1`. The user-run script pins the certificate SHA-256,
checks validity before importing, and installs trust in CurrentUser only. Keep private
keys outside Git and the renderer. Certificate rotation must update the secrets,
public certificate and documented fingerprint together. Self-signed trust is a
one-time user action; do not claim it guarantees no SmartScreen warnings.

`build/installer.nsh` adds an unchecked finish-page trust option; trust is never
an install hook. Silent installs and updates skip it. `win.extraFiles` embeds the
public certificate, trust script and instructions in `windows-signing/`. The finish
action uses `StdUtils.ExecShellAsUser`; `-FromInstaller` refuses an elevated token
so a shell fallback cannot change the administrator's trust. Separate release
assets remain the alternative. Uninstall does not remove user-managed trust.

Auto-update does not need that trust. electron-updater accepts a downloaded
installer only when Windows calls its signature Valid, so on a machine without
the trust every update was downloaded and thrown away. `main/update-signature.ts`
wraps the NSIS verifier (`verifyUpdateCodeSignature`, set in `updater.ts` on
win32): it accepts one more case — the signature is intact, the only fault is
the untrusted root (`StatusMessage` compared with Windows' own text for
CERT_E_UNTRUSTEDROOT, since it is localized), and the signer certificate's
SHA-256 is `PINNED_SIGNER_SHA256`. HashMismatch, no signature, another signer
and a Valid signature all go to electron-updater's verifier unchanged. The file
path reaches PowerShell through the environment, never the command line, and
is compared with the signed file's path inside PowerShell (`samePath`): stdout
comes back in the OEM code page, so a profile folder with non-ASCII letters
would garble a printed path. The probe runs without `PSModulePath`, which an
inherited PowerShell 7 value would break, as electron-updater's own call does. A
test pins the constant to `PR-Dashboard.cer` and to the trust script, so a
rotation updates all three; a release signed with a new self-signed key is
refused by every older release's pin, so its users install it by hand once.
Releases 3.4.1 and older have only electron-updater's check: they need the
trust script or a manual install once.
