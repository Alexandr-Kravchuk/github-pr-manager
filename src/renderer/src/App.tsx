import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Buddy, type BuddyMood } from "./components/Buddy";
import { PrCard, prSignal } from "./components/PrCard";
import { SettingsScreen } from "./components/Settings";
import { cn, relativeTime } from "./format";
import type { DashboardResponse, PublicConfig, PullRequest } from "../../shared/types";

type RoleFilter = "all" | "author" | "reviewer";

export function App() {
  const [view, setView] = useState<"dashboard" | "settings">("dashboard");
  const [config, setConfig] = useState<PublicConfig | null>(null);
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
  const [groupByRepo, setGroupByRepo] = useState(true);
  const [showDrafts, setShowDrafts] = useState(false);
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
    const items = prs.map((p) => ({ id: p.id, comments: p.totalComments, updatedAt: p.updatedAt }));
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

  const allPrs = useMemo(() => data?.pullRequests ?? [], [data]);

  // Buddy mood mirrors the card accents (drafts excluded, like the default
  // view): any red PR → sad, else a requested review → curious, else asleep.
  const buddyMood = useMemo<BuddyMood>(() => {
    const signals = allPrs.filter((p) => !p.isDraft).map(prSignal);
    if (signals.includes("blocked")) return "sad";
    if (signals.includes("myReview")) return "curious";
    return "sleeping";
  }, [allPrs]);

  const counts = useMemo(
    () => ({
      total: allPrs.length,
      attention: allPrs.filter((p) => p.needsAttention).length,
      failing: allPrs.filter((p) => p.failingChecks.length > 0).length,
      fresh: allPrs.filter((p) => p.hasNewActivity).length,
      drafts: allPrs.filter((p) => p.isDraft).length,
    }),
    [allPrs],
  );

  const filtered = useMemo(
    () =>
      allPrs.filter((pr) => {
        if (!showDrafts && pr.isDraft) return false;
        if (role !== "all" && !pr.roles.includes(role)) return false;
        if (host !== "all" && pr.hostLabel !== host) return false;
        if (attentionOnly && !pr.needsAttention) return false;
        if (failingOnly && pr.failingChecks.length === 0) return false;
        if (newOnly && !pr.hasNewActivity) return false;
        if (search.trim()) {
          const q = search.toLowerCase();
          const hay = `${pr.title} ${pr.repo} ${pr.author?.login ?? ""} #${pr.number}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      }),
    [allPrs, role, host, attentionOnly, failingOnly, newOnly, search, showDrafts],
  );

  // Reviewer PRs (your turn to review) float to the top — in the flat list and
  // within each repo group. Array.prototype.sort is stable, so the rest of the
  // order is preserved.
  const sorted = useMemo(
    () =>
      [...filtered].sort(
        (a, b) => Number(b.roles.includes("reviewer")) - Number(a.roles.includes("reviewer")),
      ),
    [filtered],
  );

  const groups = useMemo(() => {
    if (!groupByRepo) return null;
    const map = new Map<string, { hostLabel: string; repo: string; prs: PullRequest[] }>();
    for (const pr of sorted) {
      const key = `${pr.hostLabel}/${pr.repo}`;
      const g = map.get(key);
      if (g) g.prs.push(pr);
      else map.set(key, { hostLabel: pr.hostLabel, repo: pr.repo, prs: [pr] });
    }
    return [...map.values()].sort((a, b) =>
      `${a.hostLabel}/${a.repo}`.localeCompare(`${b.hostLabel}/${b.repo}`),
    );
  }, [sorted, groupByRepo]);

  const allCollapsed =
    groups !== null &&
    groups.length > 0 &&
    groups.every((g) => collapsed.has(`${g.hostLabel}/${g.repo}`));

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

          <FilterChip active={attentionOnly} onClick={() => setAttentionOnly((v) => !v)}>
            ⚠ Needs attention
          </FilterChip>
          <FilterChip active={failingOnly} onClick={() => setFailingOnly((v) => !v)}>
            ✗ Failing CI
          </FilterChip>
          <FilterChip active={newOnly} onClick={() => setNewOnly((v) => !v)}>
            ✦ New comments
          </FilterChip>
          {counts.drafts > 0 && (
            <FilterChip active={showDrafts} onClick={() => setShowDrafts((v) => !v)}>
              Drafts ({counts.drafts})
            </FilterChip>
          )}
          <FilterChip active={groupByRepo} onClick={() => setGroupByRepo((v) => !v)}>
            Group by repo
          </FilterChip>
          {groups && groups.length > 0 && (
            <button
              type="button"
              onClick={() =>
                setCollapsed(
                  allCollapsed
                    ? new Set()
                    : new Set(groups.map((g) => `${g.hostLabel}/${g.repo}`)),
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
            const key = `${g.hostLabel}/${g.repo}`;
            const isCollapsed = collapsed.has(key);
            const attention = g.prs.filter((p) => p.needsAttention).length;
            return (
              <section key={key} className={isCollapsed ? "mb-3" : "mb-8"}>
                <button
                  type="button"
                  onClick={() => toggleGroup(key)}
                  aria-expanded={!isCollapsed}
                  className="-mt-2 flex w-full items-center gap-2 rounded-t-md border-b border-line py-2 text-left hover:bg-elevated/40"
                >
                  <ChevronIcon collapsed={isCollapsed} />
                  <span className="rounded bg-elevated px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-fg-subtle">
                    {g.hostLabel}
                  </span>
                  <h2 className="truncate text-sm font-semibold text-fg-secondary" title={g.repo}>
                    {g.repo}
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
                        hideRepo
                        onOpen={openPr}
                        onMarkSeen={(p) => postSeen([p])}
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
            <PrCard key={pr.id} pr={pr} onOpen={openPr} onMarkSeen={(p) => postSeen([p])} />
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

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-md border px-3 py-1.5 text-sm transition-colors",
        active
          ? "border-sky-500/60 bg-sky-500/15 text-sky-700 dark:text-sky-200"
          : "border-line-strong bg-surface text-fg-muted hover:bg-elevated",
      )}
    >
      {children}
    </button>
  );
}
