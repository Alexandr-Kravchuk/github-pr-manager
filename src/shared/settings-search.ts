// The Settings screen's layout: which tab each section lives on, and the words
// the search box finds it by. Node-free (see AGENTS.md) so the renderer can
// value-import it and the matching stays unit-tested without a DOM.

export type SettingsTabId = "general" | "notifications" | "hosts" | "integrations" | "agent";

export const SETTINGS_TABS: ReadonlyArray<{ id: SettingsTabId; label: string }> = [
  { id: "general", label: "General" },
  { id: "notifications", label: "Notifications" },
  { id: "hosts", label: "GitHub" },
  { id: "integrations", label: "Integrations" },
  { id: "agent", label: "Agent" },
];

export type SettingsSectionId =
  | "appearance"
  | "weather"
  | "refresh"
  | "behavior"
  | "notifications"
  | "gh"
  | "hosts"
  | "jira"
  | "claude"
  | "agent"
  | "agentScenarios"
  | "agentLimits"
  | "agentPermissions"
  | "agentDiagrams"
  | "agentCompanion"
  | "agentNotifications"
  | "agentPolicy";

export interface SettingsSection {
  id: SettingsSectionId;
  tab: SettingsTabId;
  title: string;
  /**
   * Every label and hint the section shows, plus the words someone would type
   * looking for it. A row the section renders but this list doesn't name is
   * one the search can't find — keep them in step when adding a setting.
   */
  keywords: string[];
}

/** In display order — within a tab, and across tabs in the search results. */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { id: "appearance", tab: "general", title: "Appearance", keywords: ["theme", "dark", "light", "system", "mode", "neumorphism", "neumorphic", "claymorphism", "clay", "neobrutalism", "brutalism", "bento", "grid", "glassmorphism", "glass", "frosted", "blur", "soft ui", "style", "look", "flat"] },
  {
    id: "refresh",
    tab: "general",
    title: "Refresh interval",
    keywords: ["poll", "polling", "seconds", "rate limit", "interval", "update frequency"],
  },
  {
    id: "behavior",
    tab: "general",
    title: "Behavior",
    keywords: [
      "launch at login",
      "startup",
      "automatically check for updates",
      "auto update",
      "close to tray",
      "menu bar",
      "background",
      "track new comments",
      "unread",
      "mark as seen",
      "comments",
      "stale prs after",
      "stale",
      "old",
      "days",
      "close pr",
      "won't do",
      "to do",
      "delete task",
    ],
  },
  {
    id: "weather",
    tab: "general",
    title: "Header weather",
    keywords: ["weather", "city", "location", "geolocation", "temperature", "icon", "snow", "rain", "sun", "clouds", "fog", "open-meteo", "header", "use my location", "forget my location"],
  },
  {
    id: "notifications",
    tab: "notifications",
    title: "Notifications",
    keywords: [
      "notify",
      "native",
      "sound",
      "alert",
      "toast",
      "review requested",
      "ci failed",
      "approved",
      "your turn",
    ],
  },
  {
    id: "gh",
    tab: "hosts",
    title: "GitHub CLI",
    keywords: ["gh", "token", "sign in", "auth", "login", "authenticated"],
  },
  {
    id: "hosts",
    tab: "hosts",
    title: "Hosts",
    keywords: [
      "github",
      "enterprise",
      "ghe",
      "graphql",
      "repositories",
      "repos",
      "owner/name",
      "label",
      "all repositories",
      "limit",
      "prs per search",
    ],
  },
  {
    id: "jira",
    tab: "integrations",
    title: "Jira",
    keywords: ["atlassian", "twg", "sign in", "api token", "site url", "email", "parent task", "group by", "issue"],
  },
  {
    id: "claude",
    tab: "integrations",
    title: "Claude",
    keywords: [
      "claude code",
      "session",
      "terminal",
      "iterm",
      "iterm2",
      "desktop",
      "open in",
      "prompt",
      "projects folder",
      "repository folders",
      "checkout",
      "drive",
      "review",
      "close",
      "explain",
      "agent prompts",
      "triage",
      "re-review",
      "after merging",
      "self-review",
      "reviewer comments",
      "explain all",
      "review all",
      "overview",
      "group",
    ],
  },
  // The Agent tab. Its words stay clear of the exact searches other sections
  // own (see the settings-search tests): no "token", "iterm" or "dark", and
  // "tray" never in a section that also says "close".
  {
    id: "agent",
    tab: "agent",
    title: "PR agent",
    keywords: [
      "agent",
      "run the pr agent",
      "background",
      "model",
      "effort",
      "language",
      "english",
      "ukrainian",
      "polish",
      "flag",
      "worktree",
      "folder",
      "merged or closed",
      "repositories",
      "only these",
      "checkout",
    ],
  },
  {
    id: "agentScenarios",
    tab: "agent",
    title: "What the agent does",
    keywords: [
      "scenario",
      "mode",
      "shadow",
      "review",
      "auto-review",
      "lines",
      "files",
      "team requests",
      "drafts",
      "hold approve",
      "change request",
      "brief",
      "big pr",
      "re-review",
      "author replied",
      "resolve",
      "approve",
      "merge",
      "merge button",
      "method",
      "squash",
      "rebase",
      "delete the branch",
      "after merging",
      "jira",
      "drive",
      "ci",
      "conflict",
      "attempts",
      "comments",
      "self-review",
      "before reviewers",
      "validate",
      "orchestrator",
      "sdlc",
      "re-approve",
      "dismissed approval",
      "stale approval",
      "base branch",
      "ask again",
    ],
  },
  {
    id: "agentLimits",
    tab: "agent",
    title: "Limits",
    keywords: ["limit", "runs at a time", "parallel", "runs per day", "stop a run", "minutes", "quiet hours", "night", "suggest", "shadow to on"],
  },
  {
    id: "agentPermissions",
    tab: "agent",
    title: "Permissions",
    keywords: ["permissions", "allowed tools", "allowlist", "push", "branch", "safety"],
  },
  {
    id: "agentDiagrams",
    tab: "agent",
    title: "Diagrams",
    keywords: ["diagram", "mermaid", "architecture", "flow", "draw", "picture", "chart"],
  },
  { id: "agentCompanion", tab: "agent", title: "Companion", keywords: ["companion", "header", "chip", "ring", "tray", "icon"] },
  {
    id: "agentNotifications",
    tab: "agent",
    title: "Agent notifications",
    keywords: ["notification", "needs a decision", "run failed", "run finished", "toast"],
  },
  { id: "agentPolicy", tab: "agent", title: "Policy", keywords: ["signature", "posted", "log", "journal", "retention", "days"] },
];

/**
 * The sections a query finds, in display order. Every word of the query must
 * occur in the section's title or keywords (case-insensitive, as a substring),
 * so "close tray" finds the window setting and not Claude's "close" prompt.
 * A blank query finds nothing — the screen then shows the tabs instead.
 */
export function searchSettings(query: string): SettingsSection[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return SETTINGS_SECTIONS.filter((s) => {
    const haystack = [s.title, ...s.keywords].join(" ").toLowerCase();
    return words.every((w) => haystack.includes(w));
  });
}

/** The sections a tab shows, in display order. */
export function sectionsOfTab(tab: SettingsTabId): SettingsSection[] {
  return SETTINGS_SECTIONS.filter((s) => s.tab === tab);
}

/** Narrows a persisted value to a tab id; anything else is the first tab. */
export function toSettingsTab(value: unknown): SettingsTabId {
  return SETTINGS_TABS.some((t) => t.id === value) ? (value as SettingsTabId) : "general";
}
