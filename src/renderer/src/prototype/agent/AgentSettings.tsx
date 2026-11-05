/**
 * PROTOTYPE — throwaway, see AgentPrototype.tsx. The "Agent" tab of the
 * Settings screen: every threshold, limit, toggle and per-scenario mode the
 * agent has, with the defaults agreed in the brainstorm. Held in memory — Save
 * on the Settings screen does not store it. Its sections carry their own
 * search words, the way `shared/settings-search.ts` does for the real ones, so
 * the Settings search box finds them too.
 */
import { useState, type ReactNode } from "react";

import { cn } from "../../format";

type Mode = "off" | "shadow" | "on";

interface ScenarioCfg {
  mode: Mode;
}

interface AgentCfg {
  enabled: boolean;
  model: string;
  effort: string;
  worktreeDir: string;
  removeWorktree: boolean;
  repoScope: "all" | "list";
  repoList: string;
  review: ScenarioCfg & { maxLines: number; maxFiles: number };
  brief: ScenarioCfg & { prompt: string };
  rereview: ScenarioCfg & { resolve: boolean; approve: boolean; prompt: string };
  merge: ScenarioCfg & {
    allReviewers: boolean;
    threadsResolved: boolean;
    ciGreen: boolean;
    method: "github" | "squash" | "merge" | "rebase";
    deleteBranch: boolean;
    afterPrompt: string;
  };
  driveCi: ScenarioCfg & { attempts: number };
  driveComments: ScenarioCfg;
  parallel: number;
  perDay: number;
  maxMinutes: number;
  quiet: boolean;
  quietFrom: string;
  quietTo: string;
  promoteAfter: number;
  tools: string;
  pushOwn: boolean;
  headerChip: boolean;
  trayState: boolean;
  notifyNeedsYou: boolean;
  notifyFailed: boolean;
  notifyFinished: boolean;
}

const DEFAULTS: AgentCfg = {
  enabled: false,
  model: "default",
  effort: "default",
  worktreeDir: "",
  removeWorktree: true,
  repoScope: "all",
  repoList: "",
  review: { mode: "shadow", maxLines: 400, maxFiles: 15 },
  brief: {
    mode: "shadow",
    prompt:
      "Explain what {url} changes and why: read the diff and the linked Jira task, then give a short summary in Ukrainian — the problem, the approach, the risky parts — and end with the decisions only a human can make. Post nothing.",
  },
  rereview: {
    mode: "shadow",
    resolve: true,
    approve: true,
    prompt:
      "The author replied in my review threads on {url}. Check every claim against the head commit: reply where a «fixed» isn't, resolve where the reply holds up, and leave design disputes to me.",
  },
  merge: {
    mode: "on",
    allReviewers: true,
    threadsResolved: true,
    ciGreen: true,
    method: "github",
    deleteBranch: true,
    afterPrompt: "/twg-jira-resolve-merged-work as a dry run for the Jira key of {url}",
  },
  driveCi: { mode: "shadow", attempts: 2 },
  driveComments: { mode: "shadow" },
  parallel: 2,
  perDay: 30,
  maxMinutes: 30,
  quiet: false,
  quietFrom: "20:00",
  quietTo: "08:00",
  promoteAfter: 10,
  tools: ["Bash(gh:*)", "Bash(git:*)", "Read", "Edit", "Grep", "Glob", "Bash(npm test:*)", "Bash(npm run typecheck:*)"].join("\n"),
  pushOwn: true,
  headerChip: true,
  trayState: true,
  notifyNeedsYou: true,
  notifyFailed: true,
  notifyFinished: false,
};

/** The Agent tab's sections and the words the Settings search finds them by. */
export const AGENT_SECTIONS: { id: string; title: string; keywords: string[] }[] = [
  { id: "general", title: "PR agent", keywords: ["agent", "enable", "model", "effort", "worktree", "folder", "repositories", "repo"] },
  {
    id: "scenarios",
    title: "What the agent does",
    keywords: [
      "scenario", "mode", "shadow", "review", "auto-review", "lines", "files", "big pr", "brief", "triage",
      "re-review", "reply", "resolve", "approve", "merge", "method", "squash", "rebase", "delete branch", "jira",
      "drive", "ci", "conflict", "attempts", "comments",
    ],
  },
  {
    id: "limits",
    title: "Limits",
    keywords: ["limit", "parallel", "runs per day", "duration", "timeout", "minutes", "quiet hours", "night", "promote"],
  },
  { id: "permissions", title: "Permissions", keywords: ["permissions", "allowed tools", "allowlist", "push", "branch", "safety"] },
  { id: "companion", title: "Companion", keywords: ["companion", "header", "chip", "tray", "icon"] },
  { id: "notify", title: "Agent notifications", keywords: ["notification", "needs you", "failed", "finished", "toast"] },
];

export function agentSectionHits(query: string): string[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return AGENT_SECTIONS.filter((s) => {
    const hay = [s.title, ...s.keywords].join(" ").toLowerCase();
    return words.every((w) => hay.includes(w));
  }).map((s) => s.id);
}

const input =
  "mt-1 w-full rounded-md border border-line-strong bg-surface px-3 py-1.5 text-sm text-fg placeholder:text-fg-faint focus:border-sky-600 focus:outline-none";
const SECTION = "mb-6 rounded-lg border border-line bg-surface/40 p-4";

/** Survives switching tabs and searching (the component remounts); a reload starts from the defaults. */
let remembered: AgentCfg = DEFAULTS;

export function AgentSettings({ only, onEditPrompts }: { only?: string[]; onEditPrompts: () => void }) {
  const [cfg, setCfgState] = useState<AgentCfg>(() => remembered);
  const setCfg = (fn: (c: AgentCfg) => AgentCfg) =>
    setCfgState((c) => {
      remembered = fn(c);
      return remembered;
    });
  const set = <K extends keyof AgentCfg>(key: K, value: AgentCfg[K]) => setCfg((c) => ({ ...c, [key]: value }));
  const setIn = <K extends "review" | "brief" | "rereview" | "merge" | "driveCi" | "driveComments">(
    key: K,
    patch: Partial<AgentCfg[K]>,
  ) => setCfg((c) => ({ ...c, [key]: { ...c[key], ...patch } }));
  const show = (id: string) => !only || only.includes(id);
  const crumb = (title: string) =>
    only ? <div className="mb-1 text-[11px] uppercase tracking-wide text-fg-faint">Agent › {title}</div> : null;
  const off = !cfg.enabled;

  return (
    <>
      {!only && (
        <div className="mb-4 rounded-lg border-2 border-dashed border-violet-500/60 bg-violet-500/[0.06] px-3 py-2 text-xs text-fg-secondary">
          <span className="mr-1 rounded bg-violet-600 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-white">Прототип</span>
          Вкладка Agent: значення живуть у пам'яті, Save їх не зберігає. Числа — дефолти з брейншторму.
        </div>
      )}

      {show("general") && (
        <div>
          {crumb("PR agent")}
          <section className={cn(SECTION, "space-y-3")}>
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-fg-secondary">PR agent</h2>
              <span className={cn("text-xs", cfg.enabled ? "text-emerald-700 dark:text-emerald-400" : "text-fg-faint")}>
                {cfg.enabled ? "on ✓" : "off"}
              </span>
            </div>
            <Check
              checked={cfg.enabled}
              onChange={(v) => set("enabled", v)}
              title="Run the PR agent"
              hint="Works on your PRs in the background with Claude Code: reviews, re-reviews, drives your PRs to green, prepares merges. Off until you switch it on."
            />
            <div className={cn("grid gap-3 sm:grid-cols-2", off && "opacity-50")}>
              <Field label="Model">
                <select value={cfg.model} onChange={(e) => set("model", e.target.value)} className={input}>
                  <option value="default">Claude Code's default</option>
                  <option value="opus">Opus 5.5</option>
                  <option value="sonnet">Sonnet 5.5</option>
                  <option value="haiku">Haiku 5.5</option>
                </select>
              </Field>
              <Field label="Effort">
                <select value={cfg.effort} onChange={(e) => set("effort", e.target.value)} className={input}>
                  <option value="default">Claude Code's default</option>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
              </Field>
              <Field label="Worktree folder" hint="Each run works in its own git worktree, so your checkout is never touched.">
                <input
                  value={cfg.worktreeDir}
                  onChange={(e) => set("worktreeDir", e.target.value)}
                  placeholder="<checkout>/.claude/worktrees"
                  className={input}
                />
              </Field>
              <div className="pt-6">
                <Check
                  checked={cfg.removeWorktree}
                  onChange={(v) => set("removeWorktree", v)}
                  title="Remove it when the PR is merged or closed"
                />
              </div>
            </div>
            <div className={cn(off && "opacity-50")}>
              <span className="block text-xs font-medium text-fg-muted">Repositories</span>
              <div className="mt-1.5 flex flex-wrap gap-4 text-sm text-fg-secondary">
                <Radio checked={cfg.repoScope === "all"} onChange={() => set("repoScope", "all")} label="Every repository with a checkout" />
                <Radio checked={cfg.repoScope === "list"} onChange={() => set("repoScope", "list")} label="Only these" />
              </div>
              {cfg.repoScope === "list" && (
                <textarea
                  value={cfg.repoList}
                  onChange={(e) => set("repoList", e.target.value)}
                  rows={3}
                  placeholder={"owner/repo\nowner/another-repo"}
                  className={cn(input, "font-mono text-xs")}
                />
              )}
            </div>
          </section>
        </div>
      )}

      {show("scenarios") && (
        <div>
          {crumb("What the agent does")}
          <section className={cn(SECTION, off && "opacity-50")}>
            <h2 className="text-sm font-semibold text-fg-secondary">What the agent does</h2>
            <p className="mt-1 text-xs text-fg-subtle">
              Off — never. Shadow — it prepares the action and waits for you. On — it acts and tells you after.
            </p>
            <div className="mt-3 divide-y divide-line">
              <Scenario
                title="A review is requested of you"
                prompt={<PromptLink name="Your review is due" onClick={onEditPrompts} />}
                mode={cfg.review.mode}
                onMode={(m) => setIn("review", { mode: m })}
              >
                <div className="flex flex-wrap items-center gap-2 text-sm text-fg-secondary">
                  Review it on its own when it has at most
                  <Num value={cfg.review.maxLines} min={1} max={100000} onChange={(v) => setIn("review", { maxLines: v })} unit="lines" />
                  and
                  <Num value={cfg.review.maxFiles} min={1} max={5000} onChange={(v) => setIn("review", { maxFiles: v })} unit="files" />
                </div>
                <p className="mt-1 text-xs text-fg-faint">A bigger PR gets the brief below instead, and nothing is posted.</p>
              </Scenario>

              <Scenario
                title="A big PR is requested of you"
                prompt={<span className="text-fg-faint">Brief prompt — new, lives with the others in Integrations › Claude</span>}
                mode={cfg.brief.mode === "on" ? "shadow" : cfg.brief.mode}
                onMode={(m) => setIn("brief", { mode: m })}
                modes={["off", "shadow"]}
              >
                <textarea value={cfg.brief.prompt} onChange={(e) => setIn("brief", { prompt: e.target.value })} rows={3} className={cn(input, "text-xs")} />
              </Scenario>

              <Scenario
                title="The author replied in your threads"
                prompt={<span className="text-fg-faint">Re-review prompt — new, lives in Integrations › Claude</span>}
                mode={cfg.rereview.mode}
                onMode={(m) => setIn("rereview", { mode: m })}
              >
                <div className="space-y-2">
                  <Check checked={cfg.rereview.resolve} onChange={(v) => setIn("rereview", { resolve: v })} title="Resolve the threads where the reply holds up" />
                  <Check checked={cfg.rereview.approve} onChange={(v) => setIn("rereview", { approve: v })} title="Approve once all your threads are closed" />
                  <p className="text-xs text-fg-faint">A «fixed» that isn't gets a reply; a design dispute always comes to you.</p>
                  <textarea value={cfg.rereview.prompt} onChange={(e) => setIn("rereview", { prompt: e.target.value })} rows={2} className={cn(input, "text-xs")} />
                </div>
              </Scenario>

              <Scenario
                title="Your PR is ready to merge"
                prompt={<span className="text-fg-faint">The merge itself takes no model call</span>}
                mode={cfg.merge.mode === "shadow" ? "on" : cfg.merge.mode}
                onMode={(m) => setIn("merge", { mode: m })}
                modes={["off", "on"]}
                onLabel="Offer"
              >
                <div className="space-y-2">
                  <span className="block text-xs font-medium text-fg-muted">Offer the Merge button when</span>
                  <Check checked={cfg.merge.allReviewers} onChange={(v) => setIn("merge", { allReviewers: v })} title="Every requested reviewer approved" />
                  <Check checked={cfg.merge.threadsResolved} onChange={(v) => setIn("merge", { threadsResolved: v })} title="Every thread is resolved" />
                  <Check checked={cfg.merge.ciGreen} onChange={(v) => setIn("merge", { ciGreen: v })} title="Every check is green" />
                  <div className="grid gap-3 pt-1 sm:grid-cols-2">
                    <Field label="Merge method">
                      <select
                        value={cfg.merge.method}
                        onChange={(e) => setIn("merge", { method: e.target.value as AgentCfg["merge"]["method"] })}
                        className={input}
                      >
                        <option value="github">GitHub's suggestion for the repo</option>
                        <option value="squash">Squash and merge</option>
                        <option value="merge">Merge commit</option>
                        <option value="rebase">Rebase and merge</option>
                      </select>
                    </Field>
                    <div className="pt-6">
                      <Check checked={cfg.merge.deleteBranch} onChange={(v) => setIn("merge", { deleteBranch: v })} title="Delete the branch after merging" />
                    </div>
                  </div>
                  <Field label="After merging, run">
                    <input value={cfg.merge.afterPrompt} onChange={(e) => setIn("merge", { afterPrompt: e.target.value })} className={cn(input, "text-xs")} />
                  </Field>
                  <Locked>Merging always waits for your click, and the PR is re-checked right before it.</Locked>
                </div>
              </Scenario>

              <Scenario
                title="Your PR fails CI or has a conflict"
                prompt={<PromptLink name="Your PR is blocked" onClick={onEditPrompts} />}
                mode={cfg.driveCi.mode}
                onMode={(m) => setIn("driveCi", { mode: m })}
              >
                <div className="flex flex-wrap items-center gap-2 text-sm text-fg-secondary">
                  Give up after
                  <Num value={cfg.driveCi.attempts} min={1} max={10} onChange={(v) => setIn("driveCi", { attempts: v })} unit="attempts" />
                  on one PR, then hand it to you
                </div>
              </Scenario>

              <Scenario
                title="Reviewers comment on your PR"
                prompt={<PromptLink name="Your PR is blocked" onClick={onEditPrompts} />}
                mode={cfg.driveComments.mode}
                onMode={(m) => setIn("driveComments", { mode: m })}
              >
                <p className="text-xs text-fg-faint">Checks each comment with /validate-and-fix-review-comments: fixes the confirmed ones, replies on the rest.</p>
              </Scenario>
            </div>
          </section>
        </div>
      )}

      {show("limits") && (
        <div>
          {crumb("Limits")}
          <section className={cn(SECTION, "space-y-3", off && "opacity-50")}>
            <h2 className="text-sm font-semibold text-fg-secondary">Limits</h2>
            <div className="grid gap-3 sm:grid-cols-3">
              <NumField label="Runs at a time" value={cfg.parallel} min={1} max={8} onChange={(v) => set("parallel", v)} />
              <NumField label="Runs per day" value={cfg.perDay} min={1} max={500} onChange={(v) => set("perDay", v)} />
              <NumField label="Stop a run after" value={cfg.maxMinutes} min={5} max={240} unit="min" onChange={(v) => set("maxMinutes", v)} />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Check checked={cfg.quiet} onChange={(v) => set("quiet", v)} title="Quiet hours — start nothing new between" />
              <input type="time" value={cfg.quietFrom} disabled={!cfg.quiet} onChange={(e) => set("quietFrom", e.target.value)} className={cn(input, "mt-0 w-28")} />
              <span className="text-sm text-fg-subtle">and</span>
              <input type="time" value={cfg.quietTo} disabled={!cfg.quiet} onChange={(e) => set("quietTo", e.target.value)} className={cn(input, "mt-0 w-28")} />
            </div>
            <div className="flex flex-wrap items-center gap-2 text-sm text-fg-secondary">
              Suggest switching a scenario from Shadow to On after
              <Num value={cfg.promoteAfter} min={1} max={100} onChange={(v) => set("promoteAfter", v)} unit="accepted unchanged" />
            </div>
          </section>
        </div>
      )}

      {show("permissions") && (
        <div>
          {crumb("Permissions")}
          <section className={cn(SECTION, "space-y-3", off && "opacity-50")}>
            <h2 className="text-sm font-semibold text-fg-secondary">Permissions</h2>
            <Field label="Allowed tools" hint="One per line, in Claude Code's --allowedTools syntax. Anything else is refused, not asked.">
              <textarea value={cfg.tools} onChange={(e) => set("tools", e.target.value)} rows={5} className={cn(input, "font-mono text-xs")} />
            </Field>
            <Check
              checked={cfg.pushOwn}
              onChange={(v) => set("pushOwn", v)}
              title="Allow pushing to your own PR's branch"
              hint="Needed to drive your PRs to green. Off makes those runs stop before the push and hand you the commit."
            />
            <Locked>Never pushes to anyone else's branch, never runs with permission checks skipped.</Locked>
          </section>
        </div>
      )}

      {show("companion") && (
        <div>
          {crumb("Companion")}
          <section className={cn(SECTION, "space-y-3", off && "opacity-50")}>
            <h2 className="text-sm font-semibold text-fg-secondary">Companion</h2>
            <Check checked={cfg.headerChip} onChange={(v) => set("headerChip", v)} title="Show the agent in the header" hint="The ring of its plan and what it is doing right now." />
            <Check checked={cfg.trayState} onChange={(v) => set("trayState", v)} title="Show the agent's state in the tray icon" hint="So it stays visible while the window is closed to the tray." />
          </section>
        </div>
      )}

      {show("notify") && (
        <div>
          {crumb("Agent notifications")}
          <section className={cn(SECTION, "space-y-3", off && "opacity-50")}>
            <h2 className="text-sm font-semibold text-fg-secondary">Agent notifications</h2>
            <Check checked={cfg.notifyNeedsYou} onChange={(v) => set("notifyNeedsYou", v)} title="It needs a decision from you" />
            <Check checked={cfg.notifyFailed} onChange={(v) => set("notifyFailed", v)} title="A run failed" />
            <Check checked={cfg.notifyFinished} onChange={(v) => set("notifyFinished", v)} title="A run finished" hint="Usually noise: the header chip already flashes it." />
          </section>
        </div>
      )}
    </>
  );
}

function Check({ checked, onChange, title, hint }: { checked: boolean; onChange: (v: boolean) => void; title: string; hint?: string }) {
  return (
    <label className="flex items-start gap-3">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 h-4 w-4 accent-sky-500" />
      <span>
        <span className="block text-sm text-fg-secondary">{title}</span>
        {hint && <span className="block text-xs text-fg-faint">{hint}</span>}
      </span>
    </label>
  );
}

function Radio({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <label className="flex items-center gap-2">
      <input type="radio" checked={checked} onChange={onChange} className="h-4 w-4 accent-sky-500" />
      {label}
    </label>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-fg-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-fg-faint">{hint}</span>}
    </label>
  );
}

/** A small number box that says what is wrong instead of taking a bad value. */
function Num({
  value,
  min,
  max,
  unit,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  unit?: string;
  onChange: (v: number) => void;
}) {
  const [text, setText] = useState(String(value));
  const n = Number(text);
  const bad = text.trim() === "" || !Number.isInteger(n) || n < min || n > max;
  return (
    <span className="inline-flex flex-col">
      <span className="inline-flex items-center gap-1.5">
        <input
          value={text}
          inputMode="numeric"
          onChange={(e) => {
            setText(e.target.value);
            const v = Number(e.target.value);
            if (Number.isInteger(v) && v >= min && v <= max) onChange(v);
          }}
          aria-invalid={bad}
          className={cn(
            "w-20 rounded-md border bg-surface px-2 py-1 text-sm tabular-nums text-fg focus:outline-none",
            bad ? "border-red-500" : "border-line-strong focus:border-sky-600",
          )}
        />
        {unit && <span className="text-sm text-fg-subtle">{unit}</span>}
      </span>
      {bad && (
        <span className="mt-0.5 text-[11px] text-red-700 dark:text-red-300">
          {min}–{max}
        </span>
      )}
    </span>
  );
}

function NumField(props: { label: string; value: number; min: number; max: number; unit?: string; onChange: (v: number) => void }) {
  return (
    <div>
      <span className="mb-1 block text-xs font-medium text-fg-muted">{props.label}</span>
      <Num {...props} />
    </div>
  );
}

function Locked({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-md bg-elevated/60 px-2.5 py-1.5 text-xs text-fg-muted">
      <span aria-hidden>🔒</span>
      <span>
        {children} <span className="text-fg-faint">Not a setting.</span>
      </span>
    </div>
  );
}

function PromptLink({ name, onClick }: { name: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="text-sky-700 hover:underline dark:text-sky-300">
      Prompt: «{name}» · edit in Integrations › Claude
    </button>
  );
}

const MODE_LABEL: Record<Mode, string> = { off: "Off", shadow: "Shadow", on: "On" };

function Scenario({
  title,
  prompt,
  mode,
  onMode,
  modes = ["off", "shadow", "on"],
  onLabel,
  children,
}: {
  title: string;
  prompt: ReactNode;
  mode: Mode;
  onMode: (m: Mode) => void;
  modes?: Mode[];
  onLabel?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="py-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="block text-left text-sm text-fg-secondary">
            <span className="mr-1 inline-block w-3 text-fg-faint">{open ? "▾" : "▸"}</span>
            {title}
          </button>
          <span className="ml-4 block text-xs">{prompt}</span>
        </div>
        <div role="radiogroup" aria-label={`${title}: mode`} className="inline-flex rounded-md border border-line-strong p-0.5">
          {modes.map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              onClick={() => onMode(m)}
              className={cn(
                "rounded px-2.5 py-0.5 text-xs",
                mode === m
                  ? m === "on"
                    ? "bg-emerald-600 font-medium text-white"
                    : m === "shadow"
                      ? "bg-elevated font-medium text-fg"
                      : "bg-elevated font-medium text-fg-muted"
                  : "text-fg-muted hover:text-fg-secondary",
              )}
            >
              {m === "on" && onLabel ? onLabel : MODE_LABEL[m]}
            </button>
          ))}
        </div>
      </div>
      {open && <div className="ml-4 mt-2">{children}</div>}
    </div>
  );
}
