import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Buddy, type BuddyMood } from "./components/Buddy";
import { PrCard, prSignal } from "./components/PrCard";
import { SettingsScreen } from "./components/Settings";
import { cn, relativeTime } from "./format";
import type { DashboardResponse, JiraStatus, PublicConfig, PullRequest } from "../../shared/types";

type RoleFilter = "all" | "author" | "reviewer";
type SortKey = "action" | "waiting" | "active" | "newest";
type GroupMode = "none" | "repo" | "issue" | "parent";

const SORT_LABELS: Record<SortKey, string> = {
  action: "Needs my action",
  waiting: "Longest waiting",
  active: "Recently active",
  newest: "Newest",
};

/**
 * Priority for the "Needs my action" sort — lower sorts higher. Ranks the PRs that
 * need your action soonest: a review requested of you that you haven't opened,
 * then PRs that came back to you after you engaged, then the rest.
 */
function actionRank(pr: PullRequest): number {
  const isReviewer = pr.roles.includes("reviewer");
  if (isReviewer && pr.lastSeenAt === null) return 0;
  if (pr.returnedToMe) return 1;
  if (isReviewer) return 2;
  if (prSignal(pr) === "blocked") return 3;
  return 4;
}

/** Group bucket key for PRs that don't belong to a multi-PR issue cluster. */
const OTHER_GROUP_KEY = "￿__other";

/** A rendered group of PR cards. `hostLabel` is null for issue groups (may span repos). */
interface Group {
  /** Stable identity used for the collapse state. */
  key: string;
  /** Heading text — the repo name, the issue key, or "Other". */
  label: string;
  hostLabel: string | null;
  prs: PullRequest[];
}

export function App() {
  const [view, setView] = useState<"dashboard" | "settings">("dashboard");
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [jiraStatus, setJiraStatus] = useState<JiraStatus | null>(null);
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const fetchingRef = useRef(false);
  const [whatsNew, setWhatsNew] = useState<{ version: string; url: string } | null>(null);

  // Filters
  const [search, setSearch] = useState("");
  const [role, setRole] = useState<RoleFilter>("all");
  const [host, setHost] = useState("all");
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [failingOnly, setFailingOnly] = useState(false);
  const [newOnly, setNewOnly] = useState(false);
  const [mergeableOnly, setMergeableOnly] = useState(false);
  const [noReviewsOnly, setNoReviewsOnly] = useState(false);
  const [unseenOnly, setUnseenOnly] = useState(false);
  const [sortBy, setSortBy] = useState<SortKey>("action");
  const [groupBy, setGroupBy] = useState<GroupMode>("repo");
  const [showDrafts, setShowDrafts] = useState(false);
  const [showIgnored, setShowIgnored] = useState(false);
  // Collapsed repo groups, keyed by `${hostLabel}/${repo}`. In-memory, like
  // the filters: a fresh launch starts with everything expanded.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  // Applies a snapshot received either from the initial fetch or a live event.
  const applySnapshot = useCallback((snapshot: DashboardResponse) => {
    setData(snapshot);
    setError(null);
    setConfigError(null);
  }, []);

  // Initial paint: the main process's cached snapshot (waits for the first tick).
  const loadInitial = useCallback(async () => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    setLoading(true);
    try {
      const res = await window.api.getDashboard();
      if (res.ok) {
        applySnapshot(res.snapshot);
      } else if (res.kind === "config") {
        setConfigError(res.error);
        setData(null);
      } else {
        setError(res.error);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
      fetchingRef.current = false;
    }
  }, [applySnapshot]);

  // Manual "Refresh": force an immediate poll in the main process.
  const refresh = useCallback(async () => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    setLoading(true);
    try {
      const res = await window.api.refresh();
      if (res.ok) {
        applySnapshot(res.snapshot);
      } else if (res.kind === "config") {
        setConfigError(res.error);
        setData(null);
      } else {
        setError(res.error);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
      fetchingRef.current = false;
    }
  }, [applySnapshot]);

  // Config (interval, host list) — once.
  useEffect(() => {
    window.api
      .getConfig()
      .then((r) => {
        if (r.ok) setConfig(r.config);
        else setConfigError(r.error);
      })
      .catch(() => {});
    window.api.getWhatsNew().then(setWhatsNew).catch(() => {});
    window.api.getJiraStatus().then(setJiraStatus).catch(() => {});
  }, []);

  // Subscribe to live updates first (so we don't miss an early snapshot), then
  // do the initial paint. The poller in the main process pushes a fresh snapshot
  // whenever something actually changes — no client-side polling needed.
  useEffect(() => {
    const offSnapshot = window.api.onSnapshot((snapshot) => applySnapshot(snapshot));
    const offConfigError = window.api.onConfigError((message) => {
      setConfigError(message);
      setData(null);
    });
    loadInitial();
    return () => {
      offSnapshot();
      offConfigError();
    };
  }, [loadInitial, applySnapshot]);

  // After a long suspend (laptop sleep) repaint from the cached snapshot on wake.
  useEffect(() => {
    const onWake = () => {
      if (document.visibilityState === "visible") loadInitial();
    };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
    return () => {
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
    };
  }, [loadInitial]);

  // Tick to refresh relative times.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 10000);
    return () => clearInterval(id);
  }, []);

  const postSeen = useCallback(async (prs: PullRequest[]) => {
    const items = prs.map((p) => ({
      id: p.id,
      comments: p.totalComments,
      updatedAt: p.updatedAt,
      lastCommitPushedAt: p.lastCommitPushedAt,
    }));
    if (items.length === 0) return;
    const ids = new Set(items.map((i) => i.id));
    setData((prev) =>
      prev
        ? {
            ...prev,
            pullRequests: prev.pullRequests.map((p) =>
              ids.has(p.id) ? { ...p, hasNewActivity: false } : p,
            ),
          }
        : prev,
    );
    await window.api.markSeen(items).catch(() => {});
  }, []);

  const openPr = useCallback(
    (pr: PullRequest) => {
      window.api.openExternal(pr.url).catch(() => {});
      postSeen([pr]);
    },
    [postSeen],
  );

  // Ignore / un-ignore a PR. Updates our own copy optimistically (the main
  // process persists the change and re-applies it on the next tick).
  const toggleIgnore = useCallback((pr: PullRequest) => {
    const next = !pr.isIgnored;
    setData((prev) =>
      prev
        ? {
            ...prev,
            pullRequests: prev.pullRequests.map((p) =>
              p.id === pr.id ? { ...p, isIgnored: next } : p,
            ),
          }
        : prev,
    );
    window.api.setIgnored(pr.id, next).catch(() => {});
  }, []);

  const allPrs = useMemo(() => data?.pullRequests ?? [], [data]);

  // Ignored PRs are excluded from everything (counts, buddy mood, the other
  // filters) — they only surface via the "Ignored" chip. `active` is that
  // ignored-free base the whole dashboard reasons about.
  const active = useMemo(() => allPrs.filter((p) => !p.isIgnored), [allPrs]);

  // Buddy mood mirrors the card accents (drafts excluded, like the default
  // view): any red PR → sad, else a requested review → curious, else asleep.
  const buddyMood = useMemo<BuddyMood>(() => {
    const signals = active.filter((p) => !p.isDraft).map(prSignal);
    if (signals.includes("blocked")) return "sad";
    if (signals.includes("myReview")) return "curious";
    return "sleeping";
  }, [active]);

  const counts = useMemo(
    () => ({
      total: active.length,
      attention: active.filter((p) => p.needsAttention).length,
      failing: active.filter((p) => p.failingChecks.length > 0).length,
      fresh: active.filter((p) => p.hasNewActivity).length,
      returned: active.filter((p) => p.returnedToMe).length,
      noReviews: active.filter((p) => p.hasNoReviews).length,
      unseen: active.filter((p) => p.lastSeenAt === null).length,
      drafts: active.filter((p) => p.isDraft).length,
      mergeable: active.filter((p) => p.canBeMerged).length,
      ignored: allPrs.filter((p) => p.isIgnored).length,
    }),
    [active, allPrs],
  );

  const filtered = useMemo(
    () =>
      allPrs.filter((pr) => {
        if (!showIgnored && pr.isIgnored) return false;
        if (!showDrafts && pr.isDraft) return false;
        if (role !== "all" && !pr.roles.includes(role)) return false;
        if (host !== "all" && pr.hostLabel !== host) return false;
        if (attentionOnly && !pr.needsAttention) return false;
        if (failingOnly && pr.failingChecks.length === 0) return false;
        if (newOnly && !pr.hasNewActivity) return false;
        if (mergeableOnly && !pr.canBeMerged) return false;
        if (noReviewsOnly && !pr.hasNoReviews) return false;
        if (unseenOnly && pr.lastSeenAt !== null) return false;
        if (search.trim()) {
          const q = search.toLowerCase();
          const hay = `${pr.title} ${pr.repo} ${pr.author?.login ?? ""} #${pr.number}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      }),
    [
      allPrs,
      role,
      host,
      attentionOnly,
      failingOnly,
      newOnly,
      mergeableOnly,
      noReviewsOnly,
      unseenOnly,
      search,
      showDrafts,
      showIgnored,
    ],
  );

  // Ordering applies to the flat list and within each group alike.
  const sorted = useMemo(() => {
    const arr = [...filtered];
    switch (sortBy) {
      case "action":
        // Needs my action first, ties broken by most recent activity.
        arr.sort((a, b) => actionRank(a) - actionRank(b) || b.updatedAt.localeCompare(a.updatedAt));
        break;
      case "waiting":
        // Longest-waiting first — oldest by creation time.
        arr.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        break;
      case "active":
        arr.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        break;
      case "newest":
        arr.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        break;
    }
    return arr;
  }, [filtered, sortBy]);

  const groups = useMemo<Group[] | null>(() => {
    if (groupBy === "none") return null;
    if (groupBy === "repo") {
      const map = new Map<string, Group>();
      for (const pr of sorted) {
        const key = `${pr.hostLabel}/${pr.repo}`;
        const g = map.get(key);
        if (g) g.prs.push(pr);
        else map.set(key, { key, label: pr.repo, hostLabel: pr.hostLabel, prs: [pr] });
      }
      // Map insertion order = order of each group's first (top-sorted) PR, so the
      // group holding your most important PR under the active sort leads. Within
      // a group, PRs already follow `sorted`.
      return [...map.values()];
    }
    // Issue / parent modes cluster only keys that actually have 2+ related PRs —
    // the point is to review related PRs together. Everything else (single-PR
    // keys and PRs without one) collapses into one "Other" bucket instead of a
    // forest of one-card groups.
    //
    //  - "issue"  groups by the PR's own issue key (ENG-93374).
    //  - "parent" groups by the parent task resolved from Jira (ENG-93367), so
    //    the subtasks of one task sit together; label shows the parent summary.
    const keyOf = (p: PullRequest) => (groupBy === "parent" ? p.parentKey : p.issueKey);
    const summaryOf = (key: string): string =>
      groupBy === "parent"
        ? (() => {
            const summary = sorted.find((p) => p.parentKey === key)?.parentSummary;
            return summary ? `${key} · ${summary}` : key;
          })()
        : key;

    const byKey = new Map<string, PullRequest[]>();
    for (const pr of sorted) {
      const k = keyOf(pr);
      if (!k) continue;
      const list = byKey.get(k);
      if (list) list.push(pr);
      else byKey.set(k, [pr]);
    }
    // `byKey` preserves first-appearance order, so clusters lead with the one
    // holding your most important PR under the active sort (not alphabetically).
    const multi = new Set([...byKey].filter(([, prs]) => prs.length >= 2).map(([k]) => k));
    const clusters: Group[] = [...multi].map((key) => ({
      key,
      label: summaryOf(key),
      hostLabel: null,
      prs: sorted.filter((p) => keyOf(p) === key),
    }));
    const other = sorted.filter((p) => {
      const k = keyOf(p);
      return !k || !multi.has(k);
    });
    if (other.length > 0) {
      clusters.push({ key: OTHER_GROUP_KEY, label: "Other", hostLabel: null, prs: other });
    }
    return clusters;
  }, [sorted, groupBy]);

  const allCollapsed =
    groups !== null && groups.length > 0 && groups.every((g) => collapsed.has(g.key));

  const toggleGroup = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const noHosts = config !== null && config.hosts.length === 0;

  if (view === "settings") {
    return (
      <SettingsScreen
        onClose={() => {
          setView("dashboard");
          // Refresh the host-filter list; the save already triggered a poll
          // whose snapshot arrives via the live event.
          window.api
            .getConfig()
            .then((r) => {
              if (r.ok) setConfig(r.config);
            })
            .catch(() => {});
          window.api.getJiraStatus().then(setJiraStatus).catch(() => {});
          loadInitial();
        }}
      />
    );
  }

  return (
    <div className="px-4 py-6">
      {/* Header */}
      <header className="sticky top-0 z-10 -mx-4 mb-4 border-b border-line bg-canvas/85 px-4 pb-3 pt-1 backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Buddy mood={buddyMood} />
            <div>
              <h1 className="text-xl font-semibold text-fg">Pull Requests</h1>
              <p className="text-xs text-fg-subtle">
                {counts.total} PRs · {counts.attention} need attention · {counts.failing} failing CI
                · {counts.fresh} with new comments
                {counts.returned > 0 && ` · ${counts.returned} back to you`}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs text-fg-muted">
            {data?.rateLimits?.map((rl) => (
              <span
                key={rl.hostLabel}
                title={`Resets: ${rl.resetAt ? new Date(rl.resetAt).toLocaleTimeString() : "—"}`}
                className="flex items-center gap-1.5 rounded bg-elevated px-2 py-1"
              >
                {rl.hostLabel}: {rl.remaining}
                <span className="text-fg-faint">·</span>
                {rl.fetchedAt && <span className="text-fg-subtle">{relativeTime(rl.fetchedAt)}</span>}
              </span>
            ))}
            {data && (
              <span
                className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-500"
                title="Live — auto-refreshing"
              />
            )}
            <button
              type="button"
              onClick={refresh}
              disabled={loading}
              className="rounded-md border border-line-strong px-3 py-1 font-medium text-fg-secondary hover:bg-elevated disabled:opacity-50"
            >
              {loading ? "Refreshing…" : "↻ Refresh"}
            </button>
            <button
              type="button"
              onClick={() => setView("settings")}
              title="Settings"
              aria-label="Settings"
              className="inline-flex items-center rounded-md border border-line-strong px-2 py-1 text-fg-secondary hover:bg-elevated"
            >
              <GearIcon />
            </button>
          </div>
        </div>
      </header>

      {/* Config error */}
      {configError && (
        <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-600/40 dark:bg-amber-950/40 dark:text-amber-200">
          <p className="font-semibold">Configuration required</p>
          <p className="mt-1 whitespace-pre-wrap text-amber-700 dark:text-amber-100/90">
            {configError}
          </p>
        </div>
      )}

      {/* Fetch error */}
      {error && (
        <div className="mb-4 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-600/40 dark:bg-red-950/40 dark:text-red-200">
          Failed to fetch data: {error}
        </div>
      )}

      {/* Per-host errors */}
      {data?.errors?.map((e) => (
        <div
          key={e.hostLabel}
          className="mb-2 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-600/40 dark:bg-red-950/30 dark:text-red-200"
        >
          <span className="font-semibold">{e.hostLabel}:</span> {e.message}
        </div>
      ))}

      {/* Filter bar */}
      {!configError && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by title, repo, author…"
            className="min-w-[14rem] flex-1 rounded-md border border-line-strong bg-surface px-3 py-1.5 text-sm text-fg placeholder:text-fg-faint focus:border-sky-600 focus:outline-none"
          />

          <select
            value={role}
            onChange={(e) => setRole(e.target.value as RoleFilter)}
            className="rounded-md border border-line-strong bg-surface px-2 py-1.5 text-sm text-fg-secondary"
          >
            <option value="all">All roles</option>
            <option value="author">I&apos;m the author</option>
            <option value="reviewer">I&apos;m a reviewer</option>
          </select>

          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortKey)}
            title="Sort order"
            aria-label="Sort order"
            className="rounded-md border border-line-strong bg-surface px-2 py-1.5 text-sm text-fg-secondary"
          >
            {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
              <option key={k} value={k}>
                Sort: {SORT_LABELS[k]}
              </option>
            ))}
          </select>

          <select
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value as GroupMode)}
            title="Grouping"
            aria-label="Grouping"
            className="rounded-md border border-line-strong bg-surface px-2 py-1.5 text-sm text-fg-secondary"
          >
            <option value="none">No grouping</option>
            <option value="repo">Group by repo</option>
            <option value="issue">Group by issue</option>
            {jiraStatus?.configured && <option value="parent">Group by parent task</option>}
          </select>

          {config && config.hosts.length > 1 && (
            <select
              value={host}
              onChange={(e) => setHost(e.target.value)}
              className="rounded-md border border-line-strong bg-surface px-2 py-1.5 text-sm text-fg-secondary"
            >
              <option value="all">All hosts</option>
              {config.hosts.map((h) => (
                <option key={h.label} value={h.label}>
                  {h.label}
                </option>
              ))}
            </select>
          )}

          <FilterChip active={attentionOnly} onClick={() => setAttentionOnly((v) => !v)} tone="amber">
            ⚠ Needs attention
          </FilterChip>
          <FilterChip active={failingOnly} onClick={() => setFailingOnly((v) => !v)} tone="red">
            ✗ Failing CI
          </FilterChip>
          <FilterChip active={newOnly} onClick={() => setNewOnly((v) => !v)} tone="violet">
            ✦ New comments
          </FilterChip>
          <FilterChip active={mergeableOnly} onClick={() => setMergeableOnly((v) => !v)} tone="green">
            ✔ Ready to merge{counts.mergeable > 0 ? ` (${counts.mergeable})` : ""}
          </FilterChip>
          <FilterChip active={noReviewsOnly} onClick={() => setNoReviewsOnly((v) => !v)}>
            ◷ No reviews yet{counts.noReviews > 0 ? ` (${counts.noReviews})` : ""}
          </FilterChip>
          <FilterChip active={unseenOnly} onClick={() => setUnseenOnly((v) => !v)}>
            ◎ Not yet seen{counts.unseen > 0 ? ` (${counts.unseen})` : ""}
          </FilterChip>
          {counts.drafts > 0 && (
            <FilterChip active={showDrafts} onClick={() => setShowDrafts((v) => !v)}>
              Drafts ({counts.drafts})
            </FilterChip>
          )}
          {counts.ignored > 0 && (
            <FilterChip active={showIgnored} onClick={() => setShowIgnored((v) => !v)}>
              Ignored ({counts.ignored})
            </FilterChip>
          )}
          {groups && groups.length > 0 && (
            <button
              type="button"
              onClick={() =>
                setCollapsed(
                  allCollapsed ? new Set() : new Set(groups.map((g) => g.key)),
                )
              }
              title={allCollapsed ? "Expand all groups" : "Collapse all groups"}
              aria-label={allCollapsed ? "Expand all groups" : "Collapse all groups"}
              className="inline-flex items-center rounded-md border border-line-strong bg-surface px-2.5 py-2 text-fg-muted transition-colors hover:bg-elevated hover:text-fg-secondary"
            >
              <FoldIcon expand={allCollapsed} />
            </button>
          )}
        </div>
      )}

      {/* No hosts configured yet — guide to Settings. */}
      {!configError && noHosts && (
        <div className="rounded-lg border border-line bg-surface/40 p-8 text-center text-sm text-fg-muted">
          <p>No repositories configured yet.</p>
          <button
            type="button"
            onClick={() => setView("settings")}
            className="mt-3 rounded-md border border-sky-500/60 bg-sky-500/15 px-3 py-1.5 text-sm font-medium text-sky-700 dark:text-sky-200 hover:bg-sky-500/25"
          >
            Open Settings
          </button>
        </div>
      )}

      {/* Content */}
      {!configError && !noHosts && data && filtered.length === 0 && (
        <div className="rounded-lg border border-line bg-surface/40 p-8 text-center text-sm text-fg-subtle">
          {allPrs.length === 0
            ? "No open pull requests where you're involved in the added repositories."
            : "No PRs match the current filters."}
        </div>
      )}

      {!configError && !data && !error && (
        <div className="p-8 text-center text-sm text-fg-subtle">Loading…</div>
      )}

      {groups ? (
        <div>
          {groups.map((g) => {
            const isCollapsed = collapsed.has(g.key);
            const attention = g.prs.filter((p) => p.needsAttention).length;
            return (
              <section key={g.key} className={isCollapsed ? "mb-3" : "mb-8"}>
                <button
                  type="button"
                  onClick={() => toggleGroup(g.key)}
                  aria-expanded={!isCollapsed}
                  className="-mt-2 flex w-full items-center gap-2 rounded-t-md border-b border-line py-2 text-left hover:bg-elevated/40"
                >
                  <ChevronIcon collapsed={isCollapsed} />
                  {g.hostLabel && (
                    <span className="rounded bg-elevated px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-fg-subtle">
                      {g.hostLabel}
                    </span>
                  )}
                  <h2 className="truncate text-sm font-semibold text-fg-secondary" title={g.label}>
                    {g.label}
                  </h2>
                  <span className="rounded-full border border-line-strong px-2 py-0.5 text-xs text-fg-muted">
                    {g.prs.length}
                  </span>
                  {isCollapsed && attention > 0 && (
                    <span
                      className="rounded-full bg-red-500/15 px-2 py-0.5 text-xs font-medium text-red-600 dark:text-red-300"
                      title={`${attention} PR(s) need attention`}
                    >
                      ⚠ {attention}
                    </span>
                  )}
                </button>
                {!isCollapsed && (
                  <div className="mt-3 grid gap-2.5 pl-2 md:grid-cols-2 2xl:grid-cols-3 3xl:grid-cols-4 4xl:grid-cols-5">
                    {g.prs.map((pr) => (
                      <PrCard
                        key={pr.id}
                        pr={pr}
                        hideRepo={groupBy === "repo"}
                        onOpen={openPr}
                        onMarkSeen={(p) => postSeen([p])}
                        onToggleIgnore={toggleIgnore}
                      />
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      ) : (
        <div className="grid gap-2.5 md:grid-cols-2 2xl:grid-cols-3 3xl:grid-cols-4 4xl:grid-cols-5">
          {sorted.map((pr) => (
            <PrCard
              key={pr.id}
              pr={pr}
              onOpen={openPr}
              onMarkSeen={(p) => postSeen([p])}
              onToggleIgnore={toggleIgnore}
            />
          ))}
        </div>
      )}

      <div className="pointer-events-none fixed bottom-2 right-3 z-10 flex items-center gap-2 text-[11px]">
        {whatsNew && (
          <button
            type="button"
            onClick={() => {
              window.api.openExternal(whatsNew.url).catch(() => {});
              window.api.dismissWhatsNew().catch(() => {});
              setWhatsNew(null);
            }}
            className="pointer-events-auto rounded-md border border-sky-500/50 bg-sky-500/15 px-2 py-0.5 font-medium text-sky-600 transition-colors hover:bg-sky-500/25 dark:text-sky-300"
          >
            What&apos;s new in v{whatsNew.version}
          </button>
        )}
        {data?.version && (
          <span className="text-fg-faint">v{data.version}</span>
        )}
      </div>
    </div>
  );
}

/** Chevrons pointing apart (expand) or toward the middle (collapse). */
function FoldIcon({ expand }: { expand: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {expand ? (
        <>
          <path d="m7 15 5 5 5-5" />
          <path d="m7 9 5-5 5 5" />
        </>
      ) : (
        <>
          <path d="m7 20 5-5 5 5" />
          <path d="m7 4 5 5 5-5" />
        </>
      )}
    </svg>
  );
}

function ChevronIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={cn(
        "shrink-0 text-fg-muted transition-transform",
        collapsed ? "-rotate-90" : "rotate-0",
      )}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

/** Active-state color per chip. Full literal class strings so Tailwind keeps them. */
type ChipTone = "sky" | "amber" | "red" | "violet" | "green";

const CHIP_TONE_ACTIVE: Record<ChipTone, string> = {
  sky: "border-sky-500/60 bg-sky-500/15 text-sky-700 dark:text-sky-200",
  amber: "border-amber-500/60 bg-amber-500/15 text-amber-700 dark:text-amber-200",
  red: "border-red-500/60 bg-red-500/15 text-red-700 dark:text-red-200",
  violet: "border-violet-500/60 bg-violet-500/15 text-violet-700 dark:text-violet-200",
  green: "border-emerald-500/60 bg-emerald-500/15 text-emerald-700 dark:text-emerald-200",
};

function FilterChip({
  active,
  onClick,
  children,
  tone = "sky",
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  tone?: ChipTone;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-md border px-3 py-1.5 text-sm transition-colors",
        active
          ? CHIP_TONE_ACTIVE[tone]
          : "border-line-strong bg-surface text-fg-muted hover:bg-elevated",
      )}
    >
      {children}
    </button>
  );
}
