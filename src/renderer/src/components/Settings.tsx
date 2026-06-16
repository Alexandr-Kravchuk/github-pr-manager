import { useCallback, useEffect, useState } from "react";

import type { GhStatus, Settings, SettingsHost } from "../../../shared/types";
import { cn } from "../format";

const GITHUB_GRAPHQL = "https://api.github.com/graphql";

function emptyHost(): SettingsHost {
  return { label: "", graphqlUrl: "", repos: [] };
}

/** Derives the gh hostname from a GraphQL URL — renderer-side mirror of the
 *  main-process helper (kept tiny so we don't import the Node module here). */
function ghHostname(graphqlUrl: string): string {
  try {
    const host = new URL(graphqlUrl).hostname;
    if (host === "api.github.com") return "github.com";
    if (host.startsWith("api.")) return host.slice("api.".length);
    return host;
  } catch {
    return "";
  }
}

export function SettingsScreen({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [gh, setGh] = useState<GhStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadGh = useCallback(() => {
    window.api.getGhStatus().then(setGh).catch(() => {});
  }, []);

  useEffect(() => {
    window.api
      .getSettings()
      .then(setSettings)
      .catch((e) => setError((e as Error).message));
    loadGh();
  }, [loadGh]);

  const updateHost = (i: number, patch: Partial<SettingsHost>) =>
    setSettings((s) =>
      s ? { ...s, hosts: s.hosts.map((h, j) => (j === i ? { ...h, ...patch } : h)) } : s,
    );
  const addHost = (preset?: SettingsHost) =>
    setSettings((s) => (s ? { ...s, hosts: [...s.hosts, preset ?? emptyHost()] } : s));
  const removeHost = (i: number) =>
    setSettings((s) => (s ? { ...s, hosts: s.hosts.filter((_, j) => j !== i) } : s));

  const save = async () => {
    if (!settings) return;
    setSaving(true);
    setError(null);
    try {
      const res = await window.api.saveSettings(settings);
      if (res.ok) {
        onClose();
      } else {
        setError(res.error);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (!settings) {
    return <div className="p-8 text-sm text-zinc-500">Loading settings…</div>;
  }

  const labelCls = "block text-xs font-medium text-zinc-400";
  const inputCls =
    "mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-sky-600 focus:outline-none";

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <header className="mb-5 flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-zinc-100">Settings</h1>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="rounded-md border border-sky-500/60 bg-sky-500/15 px-3 py-1.5 text-sm font-medium text-sky-200 hover:bg-sky-500/25 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </header>

      {error && (
        <div className="mb-4 rounded-lg border border-red-600/40 bg-red-950/40 p-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {/* gh CLI status / guidance */}
      <section className="mb-6 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-200">GitHub CLI</h2>
          <button
            type="button"
            onClick={loadGh}
            className="rounded-md border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800"
          >
            Re-check
          </button>
        </div>
        <p className="mt-1 text-xs text-zinc-500">
          Tokens are read from the <code className="text-zinc-400">gh</code> CLI you&apos;re already
          signed into — nothing is stored by this app.
        </p>
        {gh && !gh.installed && (
          <p className="mt-2 text-sm text-amber-300">
            The <code>gh</code> CLI was not found. Install it from{" "}
            <button
              type="button"
              onClick={() => window.api.openExternal("https://cli.github.com")}
              className="underline hover:text-amber-200"
            >
              cli.github.com
            </button>
            , then Re-check.
          </p>
        )}
        {gh && gh.installed && gh.hosts.length > 0 && (
          <ul className="mt-2 space-y-1 text-sm">
            {gh.hosts.map((h) => (
              <li key={h.hostname} className="flex flex-wrap items-center gap-2">
                <span className="text-zinc-300">{h.hostname}</span>
                {h.authenticated ? (
                  <span className="text-emerald-400">signed in ✓</span>
                ) : (
                  <span className="text-amber-300">
                    not signed in — run{" "}
                    <code className="rounded bg-zinc-800 px-1">
                      gh auth login --hostname {h.hostname}
                    </code>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Poll interval */}
      <section className="mb-6">
        <label className={labelCls} htmlFor="poll">
          Refresh interval (seconds)
        </label>
        <input
          id="poll"
          type="number"
          min={10}
          value={settings.pollIntervalSeconds}
          onChange={(e) =>
            setSettings((s) =>
              s ? { ...s, pollIntervalSeconds: Math.max(10, Number(e.target.value) || 10) } : s,
            )
          }
          className={cn(inputCls, "max-w-[10rem]")}
        />
        <p className="mt-1 text-xs text-zinc-600">
          Minimum 10s. The app backs off automatically as a host&apos;s rate limit runs low.
        </p>
      </section>

      {/* Hosts */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-200">Hosts</h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => addHost({ label: "GitHub", graphqlUrl: GITHUB_GRAPHQL, repos: [] })}
              className="rounded-md border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800"
            >
              + GitHub.com
            </button>
            <button
              type="button"
              onClick={() => addHost()}
              className="rounded-md border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800"
            >
              + Add host
            </button>
          </div>
        </div>

        {settings.hosts.length === 0 && (
          <p className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-zinc-500">
            No hosts yet. Add GitHub.com or an Enterprise host, then list the repositories to watch.
          </p>
        )}

        <div className="space-y-4">
          {settings.hosts.map((host, i) => {
            const hostname = ghHostname(host.graphqlUrl);
            const auth = gh?.hosts.find((h) => h.hostname === hostname);
            return (
              <div key={i} className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="grid flex-1 gap-3 sm:grid-cols-2">
                    <div>
                      <label className={labelCls}>Label</label>
                      <input
                        value={host.label}
                        onChange={(e) => updateHost(i, { label: e.target.value })}
                        placeholder="GitHub"
                        className={inputCls}
                      />
                    </div>
                    <div>
                      <label className={labelCls}>GraphQL URL</label>
                      <input
                        value={host.graphqlUrl}
                        onChange={(e) => updateHost(i, { graphqlUrl: e.target.value })}
                        placeholder="https://api.github.com/graphql"
                        className={inputCls}
                      />
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeHost(i)}
                    title="Remove host"
                    className="mt-5 rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-red-300"
                  >
                    Remove
                  </button>
                </div>

                <div className="mt-3">
                  <label className={labelCls}>Repositories (one owner/name per line)</label>
                  <textarea
                    value={host.repos.join("\n")}
                    onChange={(e) =>
                      updateHost(i, {
                        repos: e.target.value
                          .split("\n")
                          .map((r) => r.trim())
                          .filter((r) => r.includes("/")),
                      })
                    }
                    rows={3}
                    placeholder={"owner/repo-1\nowner/repo-2"}
                    className={cn(inputCls, "font-mono text-xs")}
                  />
                </div>

                {hostname && (
                  <p className="mt-2 text-xs">
                    <span className="text-zinc-500">{hostname}: </span>
                    {auth?.authenticated ? (
                      <span className="text-emerald-400">signed in ✓</span>
                    ) : (
                      <span className="text-amber-400">
                        not signed in (run{" "}
                        <code className="rounded bg-zinc-800 px-1">
                          gh auth login --hostname {hostname}
                        </code>
                        )
                      </span>
                    )}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
