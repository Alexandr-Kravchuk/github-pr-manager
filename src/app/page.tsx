"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { PrCard } from "@/components/PrCard";
import { cn, relativeTime } from "@/lib/format";
import type { DashboardResponse, PublicConfig, PullRequest } from "@/lib/types";

type RoleFilter = "all" | "author" | "reviewer";

export default function Dashboard() {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const fetchingRef = useRef(false);
  const versionRef = useRef<string | null>(null);

  // Filters
  const [search, setSearch] = useState("");
  const [role, setRole] = useState<RoleFilter>("all");
  const [host, setHost] = useState("all");
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [failingOnly, setFailingOnly] = useState(false);
  const [newOnly, setNewOnly] = useState(false);
  const [groupByRepo, setGroupByRepo] = useState(true);

  const pollInterval = config?.pollIntervalSeconds ?? 60;

  const fetchData = useCallback(async () => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    setLoading(true);
    try {
      const res = await fetch("/api/pull-requests", { cache: "no-store" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        if (body?.kind === "config") {
          setConfigError(body.error);
          setData(null);
        } else {
          setError(body?.error || `HTTP ${res.status}`);
        }
        return;
      }
      const json: DashboardResponse = await res.json();
      // The server is running a newer build than this tab — reload to pick it
      // up (fixes stale tabs after a redeploy, no manual refresh needed).
      if (versionRef.current && json.version && versionRef.current !== json.version) {
        window.location.reload();
        return;
      }
      versionRef.current = json.version ?? versionRef.current;
      setData(json);
      setError(null);
      setConfigError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
      fetchingRef.current = false;
    }
  }, []);

  // Config (interval, host list) — once.
  useEffect(() => {
    fetch("/api/config", { cache: "no-store" })
      .then(async (r) => {
        if (r.ok) setConfig(await r.json());
        else {
          const b = await r.json().catch(() => ({}));
          if (b?.kind === "config") setConfigError(b.error);
        }
      })
      .catch(() => {});
  }, []);

  // Initial fetch + auto-refresh on an interval.
  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, pollInterval * 1000);
    return () => clearInterval(id);
  }, [fetchData, pollInterval]);

  // Refresh when the tab/window regains focus or the network reconnects —
  // so returning to the dashboard always shows current data.
  useEffect(() => {
    const onWake = () => {
      if (document.visibilityState === "visible") fetchData();
    };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
    window.addEventListener("online", onWake);
    return () => {
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
      window.removeEventListener("online", onWake);
    };
  }, [fetchData]);

  // Tick to refresh relative times and the freshness indicator.
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
    await fetch("/api/seen", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    }).catch(() => {});
  }, []);

  const openPr = useCallback(
    (pr: PullRequest) => {
      window.open(pr.url, "_blank", "noopener,noreferrer");
      postSeen([pr]);
    },
    [postSeen],
  );

  const allPrs = useMemo(() => data?.pullRequests ?? [], [data]);

  const counts = useMemo(
    () => ({
      total: allPrs.length,
      attention: allPrs.filter((p) => p.needsAttention).length,
      failing: allPrs.filter((p) => p.failingChecks.length > 0).length,
      fresh: allPrs.filter((p) => p.hasNewActivity).length,
    }),
    [allPrs],
  );

  const filtered = useMemo(
    () =>
      allPrs.filter((pr) => {
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
    [allPrs, role, host, attentionOnly, failingOnly, newOnly, search],
  );

  const groups = useMemo(() => {
    if (!groupByRepo) return null;
    const map = new Map<string, { hostLabel: string; repo: string; prs: PullRequest[] }>();
    for (const pr of filtered) {
      const key = `${pr.hostLabel}/${pr.repo}`;
      const g = map.get(key);
      if (g) g.prs.push(pr);
      else map.set(key, { hostLabel: pr.hostLabel, repo: pr.repo, prs: [pr] });
    }
    return [...map.values()].sort((a, b) =>
      `${a.hostLabel}/${a.repo}`.localeCompare(`${b.hostLabel}/${b.repo}`),
    );
  }, [filtered, groupByRepo]);

  const fetchedAgo = useMemo(
    // tick forces relative-time recomputation
    () => (data ? relativeTime(data.fetchedAt) : ""),
    [data, tick],
  );

  // Data is "stale" if older than ~2.5× the poll interval (a poll was missed).
  const isStale = useMemo(
    () => (data ? Date.now() - new Date(data.fetchedAt).getTime() > pollInterval * 2500 : false),
    [data, tick, pollInterval],
  );

  const newInView = filtered.filter((p) => p.hasNewActivity);

  return (
    <div className="mx-auto max-w-[1800px] px-4 py-6">
      {/* Header */}
      <header className="sticky top-0 z-10 -mx-4 mb-4 border-b border-zinc-800 bg-zinc-950/85 px-4 pb-3 pt-1 backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-zinc-100">Pull Requests</h1>
            <p className="text-xs text-zinc-500">
              {counts.total} PRs · {counts.attention} need attention · {counts.failing} failing CI ·{" "}
              {counts.fresh} with new comments
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs text-zinc-400">
            {data?.rateLimits?.map((rl) => (
              <span
                key={rl.hostLabel}
                title={`Resets: ${rl.resetAt ? new Date(rl.resetAt).toLocaleTimeString() : "—"}`}
                className="rounded bg-zinc-800 px-2 py-1"
              >
                {rl.hostLabel}: {rl.remaining}
              </span>
            ))}
            {data && (
              <span className="flex items-center gap-1.5 text-zinc-500">
                <span
                  className={cn(
                    "inline-block h-2 w-2 rounded-full",
                    isStale ? "bg-amber-500" : "animate-pulse bg-emerald-500",
                  )}
                  title={isStale ? "Data may be stale" : "Live — auto-refreshing"}
                />
                updated {fetchedAgo}
              </span>
            )}
            <button
              type="button"
              onClick={fetchData}
              disabled={loading}
              className="rounded-md border border-zinc-700 px-3 py-1 font-medium text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
            >
              {loading ? "Refreshing…" : "↻ Refresh"}
            </button>
          </div>
        </div>
      </header>

      {/* Config error */}
      {configError && (
        <div className="mb-4 rounded-lg border border-amber-600/40 bg-amber-950/40 p-4 text-sm text-amber-200">
          <p className="font-semibold">Configuration required</p>
          <p className="mt-1 whitespace-pre-wrap text-amber-100/90">{configError}</p>
        </div>
      )}

      {/* Fetch error */}
      {error && (
        <div className="mb-4 rounded-lg border border-red-600/40 bg-red-950/40 p-3 text-sm text-red-200">
          Failed to fetch data: {error}
        </div>
      )}

      {/* Per-host errors */}
      {data?.errors?.map((e) => (
        <div
          key={e.hostLabel}
          className="mb-2 rounded-lg border border-red-600/40 bg-red-950/30 p-3 text-sm text-red-200"
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
            className="min-w-[14rem] flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-sky-600 focus:outline-none"
          />

          <select
            value={role}
            onChange={(e) => setRole(e.target.value as RoleFilter)}
            className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-200"
          >
            <option value="all">All roles</option>
            <option value="author">I&apos;m the author</option>
            <option value="reviewer">I&apos;m a reviewer</option>
          </select>

          {config && config.hosts.length > 1 && (
            <select
              value={host}
              onChange={(e) => setHost(e.target.value)}
              className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-200"
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
          <FilterChip active={groupByRepo} onClick={() => setGroupByRepo((v) => !v)}>
            Group by repo
          </FilterChip>

          {newInView.length > 0 && (
            <button
              type="button"
              onClick={() => postSeen(newInView)}
              className="ml-auto rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
            >
              ✓ Mark all as seen ({newInView.length})
            </button>
          )}
        </div>
      )}

      {/* Content */}
      {!configError && data && filtered.length === 0 && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-8 text-center text-sm text-zinc-500">
          {allPrs.length === 0
            ? "No open pull requests where you're involved in the added repositories."
            : "No PRs match the current filters."}
        </div>
      )}

      {!configError && !data && !error && (
        <div className="p-8 text-center text-sm text-zinc-500">Loading…</div>
      )}

      {groups ? (
        <div className="columns-1 gap-x-6 lg:columns-2 2xl:columns-3">
          {groups.map((g) => (
            <section key={`${g.hostLabel}/${g.repo}`} className="mb-8 break-inside-avoid">
              <div className="mb-3 flex items-center gap-2 border-b border-zinc-800 pb-2">
                <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                  {g.hostLabel}
                </span>
                <h2 className="truncate text-sm font-semibold text-zinc-200" title={g.repo}>
                  {g.repo}
                </h2>
                <span className="rounded-full border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400">
                  {g.prs.length}
                </span>
              </div>
              <div className="grid gap-2.5 pl-2">
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
            </section>
          ))}
        </div>
      ) : (
        <div className="grid gap-2.5 md:grid-cols-2 2xl:grid-cols-3">
          {filtered.map((pr) => (
            <PrCard key={pr.id} pr={pr} onOpen={openPr} onMarkSeen={(p) => postSeen([p])} />
          ))}
        </div>
      )}
    </div>
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
          ? "border-sky-500/60 bg-sky-500/15 text-sky-200"
          : "border-zinc-700 bg-zinc-900 text-zinc-400 hover:bg-zinc-800",
      )}
    >
      {children}
    </button>
  );
}
