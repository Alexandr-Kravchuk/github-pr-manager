import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import type {
  AgentPromptKey,
  AgentSettings,
  ClaudeSettings,
  GhStatus,
  JiraStatus,
  NotificationEventToggles,
  NotificationSettings,
  Settings,
  ThemePreference,
  UiStyle,
  WeatherLocateResult,
  WeatherStatus,
} from "../../../shared/types";
// notify.ts is deliberately Electron/Node-free (unlike the rest of shared/), so
// the renderer can value-import this default rather than mirroring it. Used
// before settings load and as a fallback for a settings file from an older
// version. Single source of truth shared with config.ts's main-process default.
import { DEFAULT_NOTIFICATION_SETTINGS as DEFAULT_NOTIFICATIONS } from "../../../shared/notify";
// Node-free (see AGENTS.md) — the defaults the Claude section starts from.
import { DEFAULT_CLAUDE_PROMPTS, DEFAULT_CLAUDE_SETTINGS } from "../../../shared/claude-launch";
// Node-free too — the Agent tab starts from these before settings load.
import { DEFAULT_AGENT_PROMPTS, DEFAULT_AGENT_SETTINGS } from "../../../shared/agent-defaults";
import { DEFAULT_STALE_AFTER_DAYS, MAX_STALE_AFTER_DAYS } from "../../../shared/stale";
import { createJiraStatusLoader } from "../../../shared/jira-status";
import { describeWeather } from "../../../shared/weather";
import {
  SETTINGS_TABS,
  searchSettings,
  sectionsOfTab,
  toSettingsTab,
  type SettingsSectionId,
  type SettingsTabId,
} from "../../../shared/settings-search";
import { applyUiStyle } from "../ui-style";
import { UI_STYLES } from "../../../shared/ui-style";
import { cn } from "../format";
import { agentSectionContent } from "./AgentSettings";

/** localStorage key of the last open Settings tab. */
const TAB_KEY = "prd:settings-tab:v1";

const GITHUB_GRAPHQL = "https://api.github.com/graphql";

// While editing, repos are kept as the raw textarea text (reposText) so typing
// newlines / partial entries isn't stripped mid-edit. They're parsed into the
// owner/name list only on save.
interface DraftHost {
  label: string;
  graphqlUrl: string;
  reposText: string;
  allRepos: boolean;
  /** Raw input text, so clearing the field to retype isn't snapped back mid-edit. */
  searchLimitText: string;
}

// Mirrors DEFAULT_SEARCH_LIMIT / MAX_SEARCH_LIMIT in shared/config.ts, which the
// renderer can't value-import (it uses `node:` builtins). Only the input's hints
// and bounds come from here: main clamps whatever is saved.
const DEFAULT_SEARCH_LIMIT = 25;
const MAX_SEARCH_LIMIT = 100;

function emptyHost(): DraftHost {
  return { label: "", graphqlUrl: "", reposText: "", allRepos: false, searchLimitText: String(DEFAULT_SEARCH_LIMIT) };
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

interface RepoFolderRow {
  repo: string;
  path: string;
}

/** The registry rows as `repoPaths`, or the message saying which row is wrong.
 *  Fully empty rows are dropped; a half-filled or repeated one is an error
 *  rather than silently lost. */
function repoFoldersToPaths(rows: RepoFolderRow[]): Record<string, string> | string {
  const out: Record<string, string> = {};
  for (const [i, row] of rows.entries()) {
    const repo = row.repo.trim();
    const dir = row.path.trim();
    if (!repo && !dir) continue;
    if (!repo.includes("/") || !dir) {
      return `Repository folders, row ${i + 1}: needs a repository as owner/name and a folder.`;
    }
    if (repo in out) return `Repository folders: ${repo} is listed twice.`;
    out[repo] = dir;
  }
  return out;
}

function parseRepos(reposText: string): string[] {
  return reposText
    .split("\n")
    .map((r) => r.trim())
    .filter((r) => r.includes("/"));
}

export function SettingsScreen({ onClose }: { onClose: () => void }) {
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState<SettingsTabId>(() => {
    try {
      return toSettingsTab(localStorage.getItem(TAB_KEY));
    } catch {
      return "general";
    }
  });
  const [query, setQuery] = useState("");
  const selectTab = (next: SettingsTabId) => {
    setTab(next);
    try {
      localStorage.setItem(TAB_KEY, next);
    } catch {
      // A remembered tab is a convenience; without storage it starts on General.
    }
  };
  const [pollIntervalSeconds, setPollIntervalSeconds] = useState(60);
  const [launchAtLogin, setLaunchAtLogin] = useState(false);
  const [autoUpdate, setAutoUpdate] = useState(true);
  const [closeToTray, setCloseToTray] = useState(true);
  const [trackComments, setTrackComments] = useState(true);
  const [staleAfterDays, setStaleAfterDays] = useState(DEFAULT_STALE_AFTER_DAYS);
  const [theme, setTheme] = useState<ThemePreference>("system");
  const [uiStyle, setUiStyle] = useState<UiStyle>("flat");
  const [weatherCity, setWeatherCity] = useState("");
  // The weather main reports is for the SAVED city; it is shown only while the
  // field still holds that city, or it would describe a place not typed there.
  const [savedWeatherCity, setSavedWeatherCity] = useState("");
  const [weather, setWeather] = useState<WeatherStatus | null>(null);
  const [locating, setLocating] = useState(false);
  const [locationNote, setLocationNote] = useState<string | null>(null);
  // Saved right away, like the theme: the location lives outside settings.json.
  const LOCATE_NOTE: Record<WeatherLocateResult["outcome"], string | null> = {
    granted: null,
    denied: "Location access is denied — allow PR Dashboard in System Settings › Privacy & Security › Location Services.",
    failed: "Your location could not be determined.",
    unavailable: "Location is not available on this system.",
    timeout: "No answer to the location prompt.",
  };
  const runLocation = (attempt: Promise<WeatherLocateResult | WeatherStatus>) => {
    setLocating(true);
    setLocationNote(null);
    attempt
      .then((r) => {
        if ("outcome" in r) {
          setWeather(r.weather);
          setLocationNote(r.message ?? LOCATE_NOTE[r.outcome]);
        } else {
          setWeather(r);
        }
      })
      .catch((e) => setLocationNote((e as Error).message))
      .finally(() => setLocating(false));
  };
  const [notifications, setNotifications] = useState<NotificationSettings>(DEFAULT_NOTIFICATIONS);
  const [hosts, setHosts] = useState<DraftHost[]>([]);
  const [claude, setClaude] = useState<ClaudeSettings>(DEFAULT_CLAUDE_SETTINGS);
  const [agent, setAgent] = useState<AgentSettings>(DEFAULT_AGENT_SETTINGS);
  // Rows of the repository → folder registry, kept as rows while editing so a
  // half-typed entry isn't dropped; turned into `claude.repoPaths` on save.
  const [repoFolders, setRepoFolders] = useState<RepoFolderRow[]>([]);
  const [gh, setGh] = useState<GhStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A preference that saved fine but could not take effect (e.g. close-to-tray
  // with no usable tray icon) — informational, not a failed save.
  const [warning, setWarning] = useState<string | null>(null);

  // Jira (parent-task grouping). baseUrl/email persist in settings; the token is
  // write-only here — stored encrypted in the main process, never read back.
  const [jiraBaseUrl, setJiraBaseUrl] = useState("");
  const [jiraEmail, setJiraEmail] = useState("");
  const [jiraToken, setJiraToken] = useState("");
  const [jira, setJira] = useState<JiraStatus | null>(null);

  const loadGh = useCallback(() => {
    window.api.getGhStatus().then(setGh).catch(() => {});
  }, []);

  const loadJira = useMemo(() => createJiraStatusLoader((mode) => window.api.getJiraStatus(mode), setJira), []);

  useEffect(() => {
    window.api
      .getSettings()
      .then((s) => {
        setPollIntervalSeconds(s.pollIntervalSeconds);
        setLaunchAtLogin(s.launchAtLogin);
        setAutoUpdate(s.autoUpdate);
        setCloseToTray(s.closeToTray);
        setTrackComments(s.trackComments);
        setStaleAfterDays(s.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS);
        setTheme(s.theme);
        setUiStyle(s.uiStyle ?? "flat");
        setWeatherCity(s.weatherCity ?? "");
        setSavedWeatherCity(s.weatherCity ?? "");
        setNotifications(s.notifications ?? DEFAULT_NOTIFICATIONS);
        setHosts(
          s.hosts.map((h) => ({
            label: h.label,
            graphqlUrl: h.graphqlUrl,
            reposText: h.repos.join("\n"),
            allRepos: h.allRepos === true,
            searchLimitText: String(h.searchLimit ?? DEFAULT_SEARCH_LIMIT),
          })),
        );
        setClaude(s.claude ?? DEFAULT_CLAUDE_SETTINGS);
        setAgent(s.agent ?? DEFAULT_AGENT_SETTINGS);
        setRepoFolders(
          Object.entries(s.claude?.repoPaths ?? {}).map(([repo, path]) => ({ repo, path })),
        );
        setJiraBaseUrl(s.jira?.baseUrl ?? "");
        setJiraEmail(s.jira?.email ?? "");
        setLoaded(true);
      })
      .catch((e) => setError((e as Error).message));
    loadGh();
    loadJira();
    window.api.getWeather().then(setWeather).catch(() => {});
  }, [loadGh, loadJira]);

  const updateHost = (i: number, patch: Partial<DraftHost>) =>
    setHosts((prev) => prev.map((h, j) => (j === i ? { ...h, ...patch } : h)));
  const addHost = (preset?: DraftHost) =>
    setHosts((prev) => [...prev, preset ?? emptyHost()]);
  const removeHost = (i: number) => setHosts((prev) => prev.filter((_, j) => j !== i));

  // Appearance applies live (no Save needed) and persists in the main process.
  const changeTheme = (next: ThemePreference) => {
    setTheme(next);
    window.api.setTheme(next).catch(() => {});
  };
  const changeUiStyle = (next: UiStyle) => {
    setUiStyle(next);
    applyUiStyle(next);
    window.api.setUiStyle(next).catch(() => {});
  };

  const [twgLoginNote, setTwgLoginNote] = useState<string | null>(null);
  const startTwgLogin = async () => {
    setTwgLoginNote(null);
    try {
      const r = await window.api.twgLogin();
      setTwgLoginNote(
        r.ok
          ? "Finish the sign-in in the terminal, then press Check again."
          : `${r.error ?? "Could not open a terminal."} Run twg login --force in a terminal.`,
      );
    } catch (e) {
      setTwgLoginNote((e as Error).message);
    }
  };

  const removeJiraToken = async () => {
    setError(null);
    try {
      await window.api.setJiraToken("");
      setJiraToken("");
      loadJira();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const setNotif = (patch: Partial<NotificationSettings>) =>
    setNotifications((prev) => ({ ...prev, ...patch }));
  const setNotifEvent = (patch: Partial<NotificationEventToggles>) =>
    setNotifications((prev) => ({ ...prev, events: { ...prev.events, ...patch } }));

  const updateRepoFolder = (i: number, patch: Partial<RepoFolderRow>) =>
    setRepoFolders((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const save = async () => {
    setSaving(true);
    setError(null);
    setWarning(null);
    try {
      const folders = repoFoldersToPaths(repoFolders);
      if (typeof folders === "string") {
        setError(folders);
        return;
      }
      const baseUrl = jiraBaseUrl.trim();
      const email = jiraEmail.trim();
      const settings: Settings = {
        pollIntervalSeconds,
        launchAtLogin,
        autoUpdate,
        closeToTray,
        theme,
        uiStyle,
        trackComments,
        notifications,
        weatherCity: weatherCity.trim(),
        hosts: hosts.map((h) => ({
          label: h.label,
          graphqlUrl: h.graphqlUrl,
          repos: parseRepos(h.reposText),
          allRepos: h.allRepos,
          // Blank or garbage falls back to the default in main's validation.
          searchLimit: Number(h.searchLimitText) || DEFAULT_SEARCH_LIMIT,
        })),
        // The site turns Jira on; the email only matters to the API-token fallback.
        jira: baseUrl ? { baseUrl, ...(email ? { email } : {}) } : undefined,
        claude: { ...claude, repoPaths: folders },
        agent,
        staleAfterDays,
      };
      const res = await window.api.saveSettings(settings);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      if (res.warning) setWarning(res.warning);
      // Store the token separately (encrypted) only if the user entered one.
      if (jiraToken.trim()) {
        const t = await window.api.setJiraToken(jiraToken.trim());
        if (!t.ok) {
          setError(t.error ?? "Failed to store the Jira token.");
          return;
        }
      }
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (!loaded) {
    return <div className="p-8 text-sm text-fg-subtle">Loading settings…</div>;
  }

  const labelCls = "block text-xs font-medium text-fg-muted";
  // `cn` only joins, it does not resolve Tailwind conflicts: a width or margin
  // added on top of `inputCls` competes with its `w-full` / `mt-1` and the
  // stylesheet order picks the winner (it was `w-full`, which squeezed the
  // Repository folders' Folder field down to a bare square). Inputs that set
  // their own width or margin build on `fieldCls` instead.
  const fieldCls =
    "rounded-md border border-line-strong bg-surface px-3 py-1.5 text-sm text-fg placeholder:text-fg-faint focus:border-sky-600 focus:outline-none";
  const inputCls = cn("mt-1 w-full", fieldCls);

  const sectionContent: Record<SettingsSectionId, ReactNode> = {
    ...agentSectionContent({
      agent,
      setAgent,
      inputCls,
      // The agent's prompts live with the Claude button's ones: one place to edit them.
      onEditPrompts: () => {
        setQuery("");
        selectTab("integrations");
      },
    }),
    appearance: (
      <section className="mb-6 rounded-lg border border-line bg-surface/40 p-4">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-sm font-semibold text-fg-secondary">Appearance</h2>
          <ThemeToggle value={theme} onChange={changeTheme} />
        </div>
        <p className="mt-1 text-xs text-fg-subtle">
          Follow the system theme, or force light or dark. Applies right away, without Save.
        </p>
        <div className="mt-3 flex items-center justify-between gap-4">
          <label className="text-sm text-fg-secondary" htmlFor="ui-style">
            Style
          </label>
          <select
            id="ui-style"
            value={uiStyle}
            onChange={(e) => changeUiStyle(e.target.value as UiStyle)}
            className={cn(fieldCls, "w-48")}
          >
            {UI_STYLES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <p className="mt-1 text-xs text-fg-subtle">
          Flat is the default. Neumorphism raises cards and buttons out of the background with a light and a dark
          shadow; Claymorphism makes them soft, rounded and pastel; Neobrutalism draws them with thick outlines, hard
          shadows and loud colours; Bento grid lays the cards out as borderless cells, some twice as wide;
          Glassmorphism turns them into frosted glass over a colourful backdrop. Each works with either theme and
          applies right away.
        </p>
      </section>
    ),
    weather: (
      <section className="mb-6 rounded-lg border border-line bg-surface/40 p-4">
        <div className="flex items-center justify-between gap-4">
          <label className="text-sm font-semibold text-fg-secondary" htmlFor="weather-city">
            Header weather
          </label>
          <input
            id="weather-city"
            type="text"
            value={weatherCity}
            maxLength={100}
            placeholder="City, e.g. Kyiv"
            onChange={(e) => setWeatherCity(e.target.value)}
            className={cn(fieldCls, "w-56")}
          />
        </div>
        <p className="mt-1 text-xs text-fg-subtle">
          A small icon next to the PR count shows the current weather there. Add the country to pick
          among same-named places (&quot;Paris, France&quot;). Only the city (or your location) is
          sent, to Open-Meteo. Empty uses your location from the button below, else shows no weather.
        </p>
        {weather && weather.state !== "off" && weatherCity.trim() === savedWeatherCity && (
          <p className={cn("mt-1 text-xs", weather.state === "ok" ? "text-fg-muted" : "text-amber-700 dark:text-amber-300")}>
            {weather.state === "ok"
              ? `Now: ${describeWeather(weather.place, weather.kind, weather.temperatureC)}`
              : weather.message}
          </p>
        )}
        {/* Location: only on this click — nothing asks for it on its own. */}
        <div className="mt-2 flex items-center gap-2 text-xs">
          {weather?.state === "ok" && weather.fromLocation && savedWeatherCity === "" ? (
            <button
              type="button"
              disabled={locating}
              onClick={() => runLocation(window.api.forgetWeatherLocation())}
              className="rounded-md border border-line-strong px-2 py-0.5 text-fg-secondary hover:bg-elevated disabled:opacity-50"
            >
              Forget my location
            </button>
          ) : (
            <button
              type="button"
              disabled={locating}
              onClick={() => runLocation(window.api.locateForWeather())}
              className="rounded-md border border-line-strong px-2 py-0.5 text-fg-secondary hover:bg-elevated disabled:opacity-50"
            >
              {locating ? "Locating…" : "Use my location"}
            </button>
          )}
          {locationNote && <span className="text-fg-subtle">{locationNote}</span>}
        </div>
      </section>
    ),
    refresh: (
      <section className="mb-6 rounded-lg border border-line bg-surface/40 p-4">
        <div className="flex items-center justify-between gap-4">
          <label className="text-sm font-semibold text-fg-secondary" htmlFor="poll">
            Refresh interval
          </label>
          <span className="flex items-center gap-2 text-xs text-fg-subtle">
            <input
              id="poll"
              type="number"
              min={10}
              value={pollIntervalSeconds}
              onChange={(e) => setPollIntervalSeconds(Math.max(10, Number(e.target.value) || 10))}
              className={cn(fieldCls, "w-24")}
            />
            seconds
          </span>
        </div>
        <p className="mt-1 text-xs text-fg-subtle">
          Minimum 10s. The app backs off automatically as a host&apos;s rate limit runs low.
        </p>
      </section>
    ),
    behavior: (
      <section className="mb-6 space-y-3 rounded-lg border border-line bg-surface/40 p-4">
        <h2 className="text-sm font-semibold text-fg-secondary">Behavior</h2>
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={launchAtLogin}
            onChange={(e) => setLaunchAtLogin(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-sky-500"
          />
          <span>
            <span className="block text-sm text-fg-secondary">Launch at login</span>
            <span className="block text-xs text-fg-faint">
              Start PR Dashboard automatically when you sign in — in the tray, when
              closing to the tray is on.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={autoUpdate}
            onChange={(e) => setAutoUpdate(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-sky-500"
          />
          <span>
            <span className="block text-sm text-fg-secondary">Automatically check for updates</span>
            <span className="block text-xs text-fg-faint">
              Download and install new versions in the background.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={closeToTray}
            onChange={(e) => setCloseToTray(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-sky-500"
          />
          <span>
            <span className="block text-sm text-fg-secondary">Close to tray</span>
            <span className="block text-xs text-fg-faint">
              Closing the window hides it instead of quitting. With notifications enabled the app
              keeps polling in the background; quit from the tray icon&apos;s menu.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={trackComments}
            onChange={(e) => setTrackComments(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-sky-500"
          />
          <span>
            <span className="block text-sm text-fg-secondary">Track new comments</span>
            <span className="block text-xs text-fg-faint">
              Keeps an unread count per PR. Off drops that channel — no &ldquo;New comments&rdquo;
              chip, badge or &ldquo;Mark as seen&rdquo; button, and no unread count in the header.
              A comment awaiting your reply and unresolved threads also stop counting towards
              &ldquo;Need attention&rdquo; (they still send a notification). Off, the dashboard is
              read from GitHub rather than from what you have already looked at, so opening a PR
              changes nothing on it, and a PR comes back to you when the author pushes after your
              review. For reading comments in GitHub itself.
            </span>
          </span>
        </label>
        <div className="flex items-start justify-between gap-4">
          <span>
            <label htmlFor="stale-days" className="block text-sm text-fg-secondary">
              Stale PRs after
            </label>
            <span className="block text-xs text-fg-faint">
              A PR open this long gets a &ldquo;Stale&rdquo; badge and chip. On your own, a
              &ldquo;Close…&rdquo; button closes it and can move its Jira task back to To Do, close it
              as Won&apos;t Do or delete it. 0 turns this off.
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-2 text-xs text-fg-subtle">
            <input
              id="stale-days"
              type="number"
              min={0}
              max={MAX_STALE_AFTER_DAYS}
              value={staleAfterDays}
              onChange={(e) =>
                setStaleAfterDays(Math.min(MAX_STALE_AFTER_DAYS, Math.max(0, Math.round(Number(e.target.value) || 0))))
              }
              className={cn(inputCls.replace("w-full", "w-20"), "mt-0")}
            />
            days
          </span>
        </div>
      </section>
    ),
    notifications: (
      <section className="mb-6 rounded-lg border border-line bg-surface/40 p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-fg-secondary">Notifications</h2>
          {notifications.enabled ? (
            <span className="text-xs text-emerald-700 dark:text-emerald-400">on ✓</span>
          ) : (
            <span className="text-xs text-fg-faint">off</span>
          )}
        </div>
        <p className="mt-1 text-xs text-fg-subtle">
          Get notified when a PR needs your attention while the app is running.
        </p>
        <div className="mt-3 space-y-3">
          <CheckRow
            checked={notifications.enabled}
            onChange={(v) => setNotif({ enabled: v })}
            title="Enable notifications"
          />
          <div className="ml-7 space-y-3 border-l border-line pl-4">
            <CheckRow
              checked={notifications.native}
              onChange={(v) => setNotif({ native: v })}
              disabled={!notifications.enabled}
              title="Show desktop notifications"
              hint="A clickable OS notification that opens the PR. Respects your Focus / Do Not Disturb settings."
            />
            <CheckRow
              checked={notifications.sound}
              onChange={(v) => setNotif({ sound: v })}
              disabled={!notifications.enabled}
              title="Play a sound"
            />
            <div className="pt-1">
              <span className="block text-xs font-medium text-fg-muted">Notify me about</span>
              <div className="mt-2 space-y-3">
                <CheckRow
                  checked={notifications.events.yourTurn}
                  onChange={(v) => setNotifEvent({ yourTurn: v })}
                  disabled={!notifications.enabled}
                  title="My turn to act"
                  hint="Review requested of me, a PR I reviewed coming back to me, or a change request / unanswered comment on my PR."
                />
                <CheckRow
                  checked={notifications.events.ciFailed}
                  onChange={(v) => setNotifEvent({ ciFailed: v })}
                  disabled={!notifications.enabled}
                  title="CI failed on my PR"
                  hint="Detected on the regular poll — may lag a few minutes behind GitHub."
                />
                <CheckRow
                  checked={notifications.events.goodNews}
                  onChange={(v) => setNotifEvent({ goodNews: v })}
                  disabled={!notifications.enabled}
                  title="My PR was approved"
                />
              </div>
            </div>
          </div>
        </div>
      </section>
    ),
    gh: (
      <section className="mb-6 rounded-lg border border-line bg-surface/40 p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-fg-secondary">GitHub CLI</h2>
          <button
            type="button"
            onClick={loadGh}
            className="rounded-md border border-line-strong px-2 py-0.5 text-xs text-fg-muted hover:bg-elevated"
          >
            Re-check
          </button>
        </div>
        <p className="mt-1 text-xs text-fg-subtle">
          Tokens are read from the <code className="text-fg-muted">gh</code> CLI you&apos;re already
          signed into — nothing is stored by this app.
        </p>
        {gh && !gh.installed && (
          <p className="mt-2 text-sm text-amber-700 dark:text-amber-300">
            The <code>gh</code> CLI was not found. Install it from{" "}
            <button
              type="button"
              onClick={() => window.api.openExternal("https://cli.github.com")}
              className="underline hover:text-amber-800 dark:hover:text-amber-200"
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
                <span className="text-fg-secondary">{h.hostname}</span>
                {h.authenticated ? (
                  <span className="text-emerald-700 dark:text-emerald-400">signed in ✓</span>
                ) : (
                  <span className="text-amber-700 dark:text-amber-300">
                    not signed in — run{" "}
                    <code className="rounded bg-elevated px-1">
                      gh auth login --hostname {h.hostname}
                    </code>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    ),
    hosts: (
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-fg-secondary">Hosts</h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => addHost({ ...emptyHost(), label: "GitHub", graphqlUrl: GITHUB_GRAPHQL })}
              className="rounded-md border border-line-strong px-2 py-0.5 text-xs text-fg-secondary hover:bg-elevated"
            >
              + GitHub.com
            </button>
            <button
              type="button"
              onClick={() => addHost()}
              className="rounded-md border border-line-strong px-2 py-0.5 text-xs text-fg-secondary hover:bg-elevated"
            >
              + Add host
            </button>
          </div>
        </div>

        {hosts.length === 0 && (
          <p className="rounded-lg border border-line bg-surface/40 p-4 text-sm text-fg-subtle">
            No hosts yet. Add GitHub.com or an Enterprise host, then list the repositories to watch
            or turn on “All repositories”.
          </p>
        )}

        <div className="space-y-4">
          {hosts.map((host, i) => {
            const hostname = ghHostname(host.graphqlUrl);
            const auth = gh?.hosts.find((h) => h.hostname === hostname);
            return (
              <div key={i} className="rounded-lg border border-line bg-surface/40 p-4">
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
                    className="mt-5 rounded-md border border-line-strong px-2 py-1 text-xs text-fg-muted hover:bg-elevated hover:text-red-600 dark:hover:text-red-300"
                  >
                    Remove
                  </button>
                </div>

                <div className="mt-3 flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
                  <label className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      checked={host.allRepos}
                      onChange={(e) => updateHost(i, { allRepos: e.target.checked })}
                      className="mt-0.5 h-4 w-4 accent-sky-500"
                    />
                    <span>
                      <span className="block text-sm text-fg-secondary">All repositories</span>
                      <span className="block text-xs text-fg-faint">
                        Every open PR on this host you opened, are asked to review (you or your
                        team) or have reviewed — no list needed.
                      </span>
                    </span>
                  </label>
                  <label className="flex items-center gap-2">
                    <span
                      className="text-xs font-medium text-fg-muted"
                      title="Each search (yours, review requests, each team, reviewed) returns up to this many PRs"
                    >
                      PRs per search
                    </span>
                    <input
                      type="number"
                      min={1}
                      max={MAX_SEARCH_LIMIT}
                      value={host.searchLimitText}
                      onChange={(e) => updateHost(i, { searchLimitText: e.target.value })}
                      placeholder={String(DEFAULT_SEARCH_LIMIT)}
                      aria-label="PRs per search"
                      className="w-20 rounded-md border border-line-strong bg-surface px-2 py-1 text-sm text-fg focus:border-sky-600 focus:outline-none"
                    />
                  </label>
                </div>

                <div className="mt-3">
                  <label className={labelCls}>
                    Repositories (one owner/name per line)
                    {host.allRepos && " — ignored while “All repositories” is on"}
                  </label>
                  <textarea
                    value={host.reposText}
                    disabled={host.allRepos}
                    onChange={(e) => updateHost(i, { reposText: e.target.value })}
                    // Grows with the list (a line to spare for the next entry),
                    // from 8 lines up to 24 — past that it scrolls; the corner
                    // grip still resizes it by hand.
                    rows={Math.min(24, Math.max(8, host.reposText.split("\n").length + 1))}
                    placeholder={"owner/repo-1\nowner/repo-2"}
                    className={cn(inputCls, "resize-y font-mono text-xs leading-5 disabled:opacity-50")}
                  />
                </div>

                {hostname && (
                  <p className="mt-2 text-xs">
                    <span className="text-fg-subtle">{hostname}: </span>
                    {auth?.authenticated ? (
                      <span className="text-emerald-700 dark:text-emerald-400">signed in ✓</span>
                    ) : (
                      <span className="text-amber-700 dark:text-amber-400">
                        not signed in (run{" "}
                        <code className="rounded bg-elevated px-1">
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
    ),
    jira: (
      <section className="mb-6 rounded-lg border border-line bg-surface/40 p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-fg-secondary">Jira (optional)</h2>
          {/* Named after the source that can sign in now, not after `configured`,
              which stays true for a signed-out twg so a saved grouping survives. */}
          {jira?.signInSource === "twg" ? (
            <span className="text-xs text-emerald-700 dark:text-emerald-400">connected via twg ✓</span>
          ) : jira?.signInSource === "token" ? (
            <span className="text-xs text-emerald-700 dark:text-emerald-400">connected via API token ✓</span>
          ) : jira?.hasConfig && jira.twg.state === "checking" ? (
            <span className="text-xs text-fg-faint">checking…</span>
          ) : jira?.hasConfig ? (
            <span className="text-xs text-amber-700 dark:text-amber-400">sign-in needed</span>
          ) : (
            <span className="text-xs text-fg-faint">not set up</span>
          )}
        </div>
        <p className="mt-1 text-xs text-fg-subtle">
          Enables <span className="text-fg-muted">Group by parent task</span> — clusters review PRs
          under their parent Jira issue. Jira is read through the Atlassian{" "}
          <code className="text-fg-muted">twg</code> CLI you&apos;re signed into, the same way GitHub
          is read through <code className="text-fg-muted">gh</code> — no token to store or renew. An
          API token is the fallback when twg isn&apos;t installed or signed in.
        </p>

        <div className="mt-3">
          <label className={labelCls}>Site URL</label>
          <input
            value={jiraBaseUrl}
            onChange={(e) => setJiraBaseUrl(e.target.value)}
            placeholder="https://your-org.atlassian.net"
            className={inputCls}
          />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-fg-secondary">twg:</span>
          {!jira || jira.twg.state === "checking" ? (
            <span className="text-fg-faint">checking…</span>
          ) : jira.twg.state === "signed-in" ? (
            <span className="text-emerald-700 dark:text-emerald-400">
              signed in{jira.twg.account ? ` as ${jira.twg.account}` : ""} ✓
            </span>
          ) : jira.twg.state === "signed-out" ? (
            <span className="text-amber-700 dark:text-amber-400">not signed in</span>
          ) : jira.twg.state === "not-installed" ? (
            <span className="text-fg-faint">not installed — the API token below is used</span>
          ) : (
            <span className="text-amber-700 dark:text-amber-400">{jira.twg.message ?? "not working"}</span>
          )}
          {jira && (jira.twg.state === "signed-out" || jira.twg.state === "error") && (
            <button
              type="button"
              onClick={startTwgLogin}
              className="rounded-md border border-line-strong px-2 py-1 text-xs text-fg-muted hover:bg-elevated"
            >
              Sign in with twg
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setJira(null);
              void loadJira(true);
            }}
            className="rounded-md border border-line-strong px-2 py-1 text-xs text-fg-muted hover:bg-elevated"
          >
            Check again
          </button>
        </div>
        {twgLoginNote && <p className="mt-1 text-xs text-fg-subtle">{twgLoginNote}</p>}

        <h3 className="mt-4 text-xs font-semibold text-fg-secondary">API token (fallback)</h3>
        <p className="mt-1 text-xs text-fg-subtle">
          Used only when twg can&apos;t be. Create one at{" "}
          <button
            type="button"
            onClick={() =>
              window.api.openExternal("https://id.atlassian.com/manage-profile/security/api-tokens")
            }
            className="underline hover:text-fg-secondary"
          >
            id.atlassian.com
          </button>
          {" "}— a read-only token with the{" "}
          <code className="text-fg-muted">read:jira-work</code> scope is enough (a classic token works
          too). Atlassian tokens expire; the dashboard tells you when Jira starts rejecting it. The
          token is stored encrypted by your OS keychain — never in settings.
        </p>

        {jira && !jira.encryptionAvailable && (
          <p className="mt-2 text-sm text-amber-700 dark:text-amber-300">
            Your OS keychain is unavailable, so the token can&apos;t be stored securely. Only twg can
            be used on this machine.
          </p>
        )}

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <label className={labelCls}>Account email</label>
            <input
              value={jiraEmail}
              onChange={(e) => setJiraEmail(e.target.value)}
              placeholder="you@company.com"
              className={inputCls}
            />
          </div>
        </div>
        <div className="mt-3">
          <label className={labelCls}>API token</label>
          <div className="flex items-center gap-2">
            <input
              type="password"
              value={jiraToken}
              onChange={(e) => setJiraToken(e.target.value)}
              placeholder={jira?.hasToken ? "•••••••• stored — paste to replace" : "Paste API token"}
              autoComplete="off"
              className={inputCls}
            />
            {jira?.hasToken && (
              <button
                type="button"
                onClick={removeJiraToken}
                className="mt-1 shrink-0 rounded-md border border-line-strong px-2 py-1.5 text-xs text-fg-muted hover:bg-elevated hover:text-red-600 dark:hover:text-red-300"
              >
                Remove
              </button>
            )}
          </div>
          <p className="mt-1 text-xs text-fg-faint">Saved with the Save button, encrypted at rest.</p>
        </div>
      </section>
    ),
    claude: (
      <section className="mb-6 rounded-lg border border-line bg-surface/40 p-4">
        {/* Same frame as the Jira block: an integration with a status on the right. */}
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-fg-secondary">Claude (optional)</h2>
          {claude.enabled ? (
            <span className="text-xs text-emerald-700 dark:text-emerald-400">on ✓</span>
          ) : (
            <span className="text-xs text-fg-faint">off</span>
          )}
        </div>
        <p className="mt-1 text-xs text-fg-subtle">
          Adds a button to each PR that starts Claude in the PR&apos;s local checkout — in a terminal
          or in Claude Desktop — with a prompt picked from the PR&apos;s state. A terminal needs the{" "}
          <code className="text-fg-muted">claude</code> CLI on your PATH.
        </p>
        <div className="mt-3">
          <CheckRow
            checked={claude.enabled}
            onChange={(enabled) => setClaude((prev) => ({ ...prev, enabled }))}
            title="Start Claude sessions from PRs"
          />
        </div>
        {/* The PR agent finds checkouts and takes its prompts from here too, so the
            block stays while either is on; "Open in" is the button's alone. */}
        {(claude.enabled || agent.enabled) && (
          <div className="mt-3 space-y-3">
            {!claude.enabled && (
              <p className="text-xs text-fg-faint">The PR agent uses the folders and prompts below.</p>
            )}
            <div className={claude.enabled ? undefined : "hidden"}>
              <label className={labelCls} htmlFor="claude-terminal">
                Open in
              </label>
              <select
                id="claude-terminal"
                value={claude.terminal}
                onChange={(e) =>
                  setClaude((prev) => ({ ...prev, terminal: e.target.value as ClaudeSettings["terminal"] }))
                }
                className={cn(inputCls, "max-w-[18rem]")}
              >
                <option value="auto">Automatic — iTerm2 if installed</option>
                <option value="iterm">iTerm2</option>
                <option value="terminal">Terminal</option>
                <option value="desktop">Claude Desktop (Code tab)</option>
              </select>
              {claude.terminal === "desktop" && (
                <p className="mt-1 text-xs text-fg-faint">
                  The prompt is only filled in — press Enter to send it — and Claude Desktop asks
                  you to confirm the folder every time.
                </p>
              )}
            </div>
            <div>
              <label className={labelCls} htmlFor="claude-root">
                Projects folder
              </label>
              <input
                id="claude-root"
                value={claude.projectsRoot}
                placeholder="~/Projects"
                onChange={(e) => setClaude((prev) => ({ ...prev, projectsRoot: e.target.value }))}
                className={inputCls}
              />
              <p className="mt-1 text-xs text-fg-faint">
                Its subfolders are matched to a PR by their git remote. A folder set below wins.
              </p>
            </div>
            {(
              [
                ["drive", "Your PR is blocked (CI, conflict, threads, changes requested)"],
                ["review", "Your review is due"],
                ["close", "Your PR is ready to merge"],
                ["explain", "Explain (from the button's menu only)"],
                ["open", "Anything else"],
                ["explainGroup", "Explain all (a Jira group's heading)"],
                ["reviewGroup", "Review all (a Jira group's heading, Claude Desktop only)"],
              ] as const
            ).map(([kind, title]) => (
              <div key={kind}>
                <label className={labelCls} htmlFor={`claude-prompt-${kind}`}>
                  {title}
                </label>
                <input
                  id={`claude-prompt-${kind}`}
                  value={claude.prompts[kind]}
                  placeholder={DEFAULT_CLAUDE_PROMPTS[kind]}
                  onChange={(e) =>
                    setClaude((prev) => ({ ...prev, prompts: { ...prev.prompts, [kind]: e.target.value } }))
                  }
                  className={cn(inputCls, "font-mono")}
                />
              </div>
            ))}
            <div className="pt-1">
              <span className={labelCls}>Agent prompts</span>
              <p className="mt-0.5 text-xs text-fg-faint">Only the PR agent runs these; they are not in the Claude button&apos;s menu.</p>
            </div>
            {(
              [
                ["triage", "Brief for a big PR"],
                ["rereview", "Re-review — the author replied in your threads"],
                ["afterMerge", "After merging your PR"],
                ["selfReview", "Self-review of your PR, before reviewers"],
                ["validateComments", "Reviewers commented on your PR"],
              ] as const satisfies ReadonlyArray<readonly [AgentPromptKey, string]>
            ).map(([key, title]) => (
              <div key={key}>
                <label className={labelCls} htmlFor={`agent-prompt-${key}`}>
                  {title}
                </label>
                <input
                  id={`agent-prompt-${key}`}
                  value={claude.agentPrompts[key]}
                  placeholder={DEFAULT_AGENT_PROMPTS[key]}
                  onChange={(e) =>
                    setClaude((prev) => ({ ...prev, agentPrompts: { ...prev.agentPrompts, [key]: e.target.value } }))
                  }
                  className={cn(inputCls, "font-mono")}
                />
              </div>
            ))}
            <p className="text-xs text-fg-faint">
              {"{url}"} is replaced with the PR link; in Explain all and Review all, {"{key}"} with
              the group's Jira key, {"{count}"} with the number of PRs and {"{urls}"} with their
              links, and in Review all {"{prompts}"} with each PR's "Your review is due" prompt for
              the sessions it starts. An empty prompt goes back to the default.
            </p>
            <div>
              <div className="flex items-center justify-between">
                <span className={labelCls}>Repository folders</span>
                <button
                  type="button"
                  onClick={() => setRepoFolders((prev) => [...prev, { repo: "", path: "" }])}
                  className="rounded-md border border-line-strong px-2 py-0.5 text-xs text-fg-secondary hover:bg-elevated"
                >
                  + Add
                </button>
              </div>
              <p className="mt-1 text-xs text-fg-faint">
                A repository listed here opens in its folder; any other one is searched for in the
                projects folder.
              </p>
              <datalist id="claude-repo-options">
                {[...new Set(hosts.flatMap((h) => parseRepos(h.reposText)))].map((repo) => (
                  <option key={repo} value={repo} />
                ))}
              </datalist>
              {repoFolders.length > 0 && (
                <div className="mt-2 space-y-1.5">
                  {repoFolders.map((row, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <input
                        value={row.repo}
                        list="claude-repo-options"
                        placeholder="owner/name"
                        aria-label="Repository"
                        onChange={(e) => updateRepoFolder(i, { repo: e.target.value })}
                        className={cn(fieldCls, "w-56 shrink-0")}
                      />
                      <input
                        value={row.path}
                        placeholder="~/Projects/name"
                        aria-label="Folder"
                        onChange={(e) => updateRepoFolder(i, { path: e.target.value })}
                        className={cn(fieldCls, "min-w-0 flex-1")}
                      />
                      <button
                        type="button"
                        onClick={() => setRepoFolders((prev) => prev.filter((_, j) => j !== i))}
                        title="Remove"
                        aria-label="Remove repository folder"
                        className="shrink-0 rounded px-1.5 text-fg-faint hover:bg-elevated hover:text-fg-secondary"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </section>
    ),
  };

  const searching = query.trim().length > 0;
  const hits = searchSettings(query);
  const hitTabs = new Set(hits.map((h) => h.tab));

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <header className="mb-5 flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-fg">Settings</h1>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-line-strong px-3 py-1.5 text-sm text-fg-secondary hover:bg-elevated"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="rounded-md border border-sky-500/60 bg-sky-500/15 px-3 py-1.5 text-sm font-medium text-sky-700 dark:text-sky-200 hover:bg-sky-500/25 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </header>

      {error && (
        <div className="mb-4 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-600/40 dark:bg-red-950/40 dark:text-red-200">
          {error}
        </div>
      )}

      {warning && (
        <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-600/40 dark:bg-amber-950/40 dark:text-amber-200">
          {warning}
        </div>
      )}

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div role="tablist" aria-label="Settings sections" className="flex rounded-md border border-line-strong p-0.5">
          {SETTINGS_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={!searching && tab === t.id}
              onClick={() => {
                setQuery("");
                selectTab(t.id);
              }}
              className={cn(
                "rounded px-3 py-1 text-sm transition-colors",
                !searching && tab === t.id
                  ? "bg-elevated font-medium text-fg"
                  : "text-fg-muted hover:text-fg-secondary",
                // While searching, a tab that holds a hit says so.
                searching && hitTabs.has(t.id) && "text-sky-700 dark:text-sky-300",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setQuery("");
          }}
          placeholder="Search settings"
          data-find-field
          aria-label="Search settings"
          className={cn(fieldCls, "min-w-[12rem] flex-1")}
        />
      </div>

      {searching ? (
        hits.length === 0 ? (
          <p className="py-8 text-center text-sm text-fg-subtle">No settings match &ldquo;{query.trim()}&rdquo;.</p>
        ) : (
          hits.map((s) => (
            <div key={s.id}>
              <div className="mb-1 text-[11px] uppercase tracking-wide text-fg-faint">
                {SETTINGS_TABS.find((t) => t.id === s.tab)?.label} › {s.title}
              </div>
              {sectionContent[s.id]}
            </div>
          ))
        )
      ) : (
        sectionsOfTab(tab).map((s) => <div key={s.id}>{sectionContent[s.id]}</div>)
      )}
    </div>
  );
}

/** A checkbox with a title + optional hint, matching the general-toggles rows. */
function CheckRow({
  checked,
  onChange,
  title,
  hint,
  disabled = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  title: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label className={cn("flex items-start gap-3", disabled && "opacity-50")}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 accent-sky-500"
      />
      <span>
        <span className="block text-sm text-fg-secondary">{title}</span>
        {hint && <span className="block text-xs text-fg-faint">{hint}</span>}
      </span>
    </label>
  );
}

const ICON_PROPS = {
  width: 15,
  height: 15,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

function MonitorIcon() {
  return (
    <svg {...ICON_PROPS}>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg {...ICON_PROPS}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </svg>
  );
}

const THEME_OPTIONS = [
  { value: "system", label: "System", Icon: MonitorIcon },
  { value: "light", label: "Light", Icon: SunIcon },
  { value: "dark", label: "Dark", Icon: MoonIcon },
] as const;

/** Segmented System / Light / Dark control (icons only), like Claude Code's. */
function ThemeToggle({
  value,
  onChange,
}: {
  value: ThemePreference;
  onChange: (theme: ThemePreference) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Appearance"
      className="inline-flex items-center gap-0.5 rounded-lg border border-line-strong bg-surface p-0.5"
    >
      {THEME_OPTIONS.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={opt.label}
            title={opt.label}
            onClick={() => onChange(opt.value)}
            className={cn(
              "flex items-center justify-center rounded-md px-2.5 py-1.5 transition-colors",
              active ? "bg-elevated text-fg" : "text-fg-subtle hover:text-fg",
            )}
          >
            <opt.Icon />
          </button>
        );
      })}
    </div>
  );
}
