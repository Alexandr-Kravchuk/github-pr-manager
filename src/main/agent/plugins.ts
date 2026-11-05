import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Agent sessions run with `--restricted`, which loads none of your settings —
// and with them none of your installed plugins or ~/.claude/skills. The skills
// a prompt names are brought back one plugin at a time with `--plugin-dir`,
// found through Claude Code's own registry (~/.claude/plugins/installed_plugins.json),
// so a session gets exactly the plugins its prompt needs and no plugin hooks
// beyond them.

export interface InstalledPlugin {
  /** "creatio-development" — the part before "@marketplace". */
  name: string;
  installPath: string;
  /** Skill folder names under `<installPath>/skills`. */
  skills: string[];
}

function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude");
}

/** The user-scope plugins Claude Code has installed, newest install per plugin. Never throws. */
export function readInstalledPlugins(configDir = claudeConfigDir()): InstalledPlugin[] {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(configDir, "plugins", "installed_plugins.json"), "utf8"));
  } catch {
    return [];
  }
  const plugins = (raw as { plugins?: unknown })?.plugins;
  if (typeof plugins !== "object" || plugins === null) return [];
  const out: InstalledPlugin[] = [];
  for (const [id, entries] of Object.entries(plugins as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue;
    const entry = entries.find(
      (e) => typeof e === "object" && e !== null && typeof (e as { installPath?: unknown }).installPath === "string",
    ) as { installPath: string } | undefined;
    if (!entry) continue;
    let skills: string[] = [];
    try {
      skills = fs
        .readdirSync(path.join(entry.installPath, "skills"), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      // A plugin without skills (hooks or MCP only) — nothing for a prompt to name.
    }
    out.push({ name: id.split("@")[0], installPath: entry.installPath, skills });
  }
  return out;
}

/**
 * The plugins a prompt's slash commands need, and the prompt with every bare
 * `/skill` that exactly one plugin provides written as `/plugin:skill` (under
 * `--restricted` a bare name would not resolve). Commands no plugin provides
 * are left as they are — Claude Code then says so in the session.
 */
export function resolveSkillRefs(prompt: string, plugins: readonly InstalledPlugin[]): { prompt: string; pluginDirs: string[] } {
  const dirs = new Set<string>();
  const out = prompt.replace(/(^|[\s(«"'])\/([A-Za-z0-9][\w.-]*)(?::([A-Za-z0-9][\w.-]*))?/g, (match, lead: string, a: string, b?: string) => {
    if (b) {
      const plugin = plugins.find((p) => p.name === a && p.skills.includes(b));
      if (plugin) dirs.add(plugin.installPath);
      return match;
    }
    const owners = plugins.filter((p) => p.skills.includes(a));
    if (owners.length !== 1) return match;
    dirs.add(owners[0].installPath);
    return `${lead}/${owners[0].name}:${a}`;
  });
  return { prompt: out, pluginDirs: [...dirs] };
}
