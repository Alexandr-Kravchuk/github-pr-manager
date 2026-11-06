import { useState, type Dispatch, type ReactNode, type SetStateAction } from "react";

// Node-free, like notify.ts — value-imported for the defaults and the number bounds,
// the same ones `validateAgent` clamps with in the main process.
import { AGENT_BOUNDS, DEFAULT_AGENT_SIGNATURE, DEFAULT_AGENT_TOOLS, type AgentBoundKey } from "../../../shared/agent-defaults";
import type { SettingsSectionId } from "../../../shared/settings-search";
import type { AgentMode, AgentRunKind, AgentSettings, MergeMethod } from "../../../shared/types";
import { cn } from "../format";

/** The Agent tab's sections — their ids, titles and search words live in settings-search.ts. */
export type AgentSectionId = Extract<SettingsSectionId, `agent${string}`>;

type SetAgent = Dispatch<SetStateAction<AgentSettings>>;
type Scenarios = AgentSettings["scenarios"];

const SECTION = "mb-6 rounded-lg border border-line bg-surface/40 p-4";
const H2 = "text-sm font-semibold text-fg-secondary";

/**
 * The Agent tab of Settings, one entry per section. Every threshold, limit,
 * toggle and per-scenario mode the agent has is here; the safety rails that
 * are deliberately not settings are shown as locked lines, so their absence
 * reads as a decision and not as something missing.
 */
export function agentSectionContent({
  agent,
  setAgent,
  inputCls,
  onEditPrompts,
}: {
  agent: AgentSettings;
  setAgent: SetAgent;
  inputCls: string;
  onEditPrompts: () => void;
}): Record<AgentSectionId, ReactNode> {
  const props = { agent, setAgent, inputCls };
  return {
    agent: <GeneralSection {...props} />,
    agentScenarios: <ScenariosSection {...props} onEditPrompts={onEditPrompts} />,
    agentLimits: <LimitsSection {...props} />,
    agentPermissions: <PermissionsSection {...props} />,
    agentCompanion: <CompanionSection {...props} />,
    agentNotifications: <NotificationsSection {...props} />,
    agentPolicy: <PolicySection {...props} />,
  };
}

interface SectionProps {
  agent: AgentSettings;
  setAgent: SetAgent;
  inputCls: string;
}

function GeneralSection({ agent, setAgent, inputCls }: SectionProps) {
  const [repoText, setRepoText] = useState(agent.repos.join("\n"));
  const [onlyThese, setOnlyThese] = useState(agent.repos.length > 0);
  const setRepos = (text: string) => {
    setRepoText(text);
    setAgent((a) => ({ ...a, repos: lines(text) }));
  };
  return (
    <section className={cn(SECTION, "space-y-3")}>
      <div className="flex items-center justify-between">
        <h2 className={H2}>PR agent</h2>
        <span className={cn("text-xs", agent.enabled ? "text-emerald-700 dark:text-emerald-400" : "text-fg-faint")}>
          {agent.enabled ? "on ✓" : "off"}
        </span>
      </div>
      <Check
        checked={agent.enabled}
        onChange={(enabled) => setAgent((a) => ({ ...a, enabled }))}
        title="Run the PR agent"
        hint="Works on your PRs in the background with Claude Code: reviews, re-reviews, drives your PRs to green and prepares merges. Off until you switch it on; whatever posts starts in Shadow."
      />
      <Dimmed off={!agent.enabled}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Model">
            <select value={agent.model} onChange={(e) => setAgent((a) => ({ ...a, model: e.target.value }))} className={inputCls}>
              <option value="">Claude Code&apos;s default</option>
              <option value="fable">Fable</option>
              <option value="opus">Opus</option>
              <option value="sonnet">Sonnet</option>
              <option value="haiku">Haiku</option>
            </select>
          </Field>
          <Field label="Effort">
            <select
              value={agent.effort}
              onChange={(e) => setAgent((a) => ({ ...a, effort: e.target.value as AgentSettings["effort"] }))}
              className={inputCls}
            >
              <option value="">Claude Code&apos;s default</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </Field>
          <Field label="Worktree folder" hint="Each run works in its own git worktree, so your checkout is never touched.">
            <input
              value={agent.worktreeDir}
              onChange={(e) => setAgent((a) => ({ ...a, worktreeDir: e.target.value }))}
              placeholder="<checkout>/.claude/worktrees"
              className={inputCls}
            />
          </Field>
          <div className="pt-6">
            <Check
              checked={agent.removeWorktree}
              onChange={(removeWorktree) => setAgent((a) => ({ ...a, removeWorktree }))}
              title="Remove it once the PR is merged or closed"
            />
          </div>
        </div>
        <div>
          <span className="block text-xs font-medium text-fg-muted">Repositories</span>
          <div className="mt-1.5 flex flex-wrap gap-4 text-sm text-fg-secondary">
            <Radio
              checked={!onlyThese}
              onChange={() => {
                setOnlyThese(false);
                setAgent((a) => ({ ...a, repos: [] }));
              }}
              label="Every repository with a checkout"
            />
            <Radio
              checked={onlyThese}
              onChange={() => {
                setOnlyThese(true);
                setAgent((a) => ({ ...a, repos: lines(repoText) }));
              }}
              label="Only these"
            />
          </div>
          {onlyThese && (
            <textarea
              value={repoText}
              onChange={(e) => setRepos(e.target.value)}
              rows={3}
              placeholder={"owner/repo\nowner/another-repo"}
              className={cn(inputCls, "font-mono text-xs")}
            />
          )}
        </div>
      </Dimmed>
    </section>
  );
}

function ScenariosSection({ agent, setAgent, inputCls, onEditPrompts }: SectionProps & { onEditPrompts: () => void }) {
  const sc = agent.scenarios;
  const patch = <K extends keyof Scenarios>(key: K, value: Partial<Scenarios[K]>) =>
    setAgent((a) => ({ ...a, scenarios: { ...a.scenarios, [key]: { ...a.scenarios[key], ...value } } }));
  return (
    <section className={SECTION}>
      <h2 className={H2}>What the agent does</h2>
      <p className="mt-1 text-xs text-fg-subtle">
        Off — never. Shadow — it does the work and waits for you before posting anything. On — it posts and tells you after.
      </p>
      <Dimmed off={!agent.enabled}>
        <div className="mt-2 divide-y divide-line">
          <Scenario
            title="A review is requested of you"
            prompt={<PromptLink name="Your review is due" onClick={onEditPrompts} />}
            mode={sc.review.mode}
            modes={["off", "shadow", "on"]}
            onMode={(mode) => patch("review", { mode })}
          >
            <div className="flex flex-wrap items-center gap-2 text-sm text-fg-secondary">
              Review it on its own when it has at most
              <Num bound="maxLines" value={sc.review.maxLines} onChange={(maxLines) => patch("review", { maxLines })} unit="lines" />
              and
              <Num bound="maxFiles" value={sc.review.maxFiles} onChange={(maxFiles) => patch("review", { maxFiles })} unit="files" />
            </div>
            <p className="mt-1 text-xs text-fg-faint">A bigger PR gets the brief below instead, and nothing is posted.</p>
            <div className="mt-2 space-y-2">
              <Check
                checked={sc.review.teamRequests}
                onChange={(teamRequests) => patch("review", { teamRequests })}
                title="Review team requests too"
                hint="Off: only requests made of you personally, so a busy team doesn't use up the daily limit."
              />
              <Check checked={sc.review.drafts} onChange={(drafts) => patch("review", { drafts })} title="Review drafts too" />
              <Check
                checked={sc.review.holdApproveOnChangeRequest}
                onChange={(holdApproveOnChangeRequest) => patch("review", { holdApproveOnChangeRequest })}
                title="Hold the approve while another reviewer's change request is open"
              />
            </div>
          </Scenario>

          <Scenario
            title="A big PR is requested of you"
            prompt={<PromptLink name="Brief" onClick={onEditPrompts} />}
            mode={sc.brief.mode}
            modes={["off", "on"]}
            onMode={(mode) => patch("brief", { mode: mode === "on" ? "on" : "off" })}
          >
            <p className="text-xs text-fg-faint">
              Writes a brief — the problem, the approach, the risky parts and the decisions for you. Nothing is posted in either mode.
            </p>
          </Scenario>

          <Scenario
            title="The author replied in your threads"
            prompt={<PromptLink name="Re-review" onClick={onEditPrompts} />}
            mode={sc.rereview.mode}
            modes={["off", "shadow", "on"]}
            onMode={(mode) => patch("rereview", { mode })}
          >
            <div className="space-y-2">
              <Check checked={sc.rereview.resolve} onChange={(resolve) => patch("rereview", { resolve })} title="Resolve the threads where the reply holds up" />
              <Check checked={sc.rereview.approve} onChange={(approve) => patch("rereview", { approve })} title="Approve once all your threads are closed" />
              <p className="text-xs text-fg-faint">A «fixed» that isn&apos;t gets a reply; a design dispute always comes to you.</p>
            </div>
          </Scenario>

          <Scenario
            title="Your PR is ready to merge"
            prompt={<span className="text-fg-faint">The merge takes no model call · after merging: the «After merging» prompt</span>}
            mode={sc.merge.mode === "offer" ? "on" : "off"}
            modes={["off", "on"]}
            onLabel="Offer"
            onMode={(mode) => patch("merge", { mode: mode === "on" ? "offer" : "off" })}
          >
            <div className="space-y-2">
              <span className="block text-xs font-medium text-fg-muted">On top of GitHub&apos;s own readiness, offer the Merge button only when</span>
              <Check
                checked={sc.merge.requireAllReviewers}
                onChange={(requireAllReviewers) => patch("merge", { requireAllReviewers })}
                title="Every reviewer you requested by name approved"
              />
              <Check
                checked={sc.merge.requireThreadsResolved}
                onChange={(requireThreadsResolved) => patch("merge", { requireThreadsResolved })}
                title="Every thread is resolved"
              />
              <Check
                checked={sc.merge.requireChecksGreen}
                onChange={(requireChecksGreen) => patch("merge", { requireChecksGreen })}
                title="Every check is green"
              />
              <div className="grid gap-3 pt-1 sm:grid-cols-2">
                <Field label="Merge method">
                  <select
                    value={sc.merge.method}
                    onChange={(e) => patch("merge", { method: e.target.value as "github" | MergeMethod })}
                    className={inputCls}
                  >
                    <option value="github">GitHub&apos;s suggestion for the repository</option>
                    <option value="squash">Squash and merge</option>
                    <option value="merge">Merge commit</option>
                    <option value="rebase">Rebase and merge</option>
                  </select>
                </Field>
                <div className="pt-6">
                  <Check checked={sc.merge.deleteBranch} onChange={(deleteBranch) => patch("merge", { deleteBranch })} title="Delete the branch after merging" />
                </div>
              </div>
              <Locked>Merging always waits for your click, and the PR is checked again right before it.</Locked>
            </div>
          </Scenario>

          <Scenario
            title="Your PR, before reviewers"
            prompt={<PromptLink name="Self-review" onClick={onEditPrompts} />}
            mode={sc.selfReview.mode}
            modes={["off", "shadow", "on"]}
            onMode={(mode) => patch("selfReview", { mode })}
          >
            <p className="text-xs text-fg-faint">
              Each head you push gets a self-review: the review in dry run (nothing posted), its findings validated, the confirmed ones fixed as commits — pushed on your
              Push in Shadow. Not a head the agent pushed itself.
            </p>
          </Scenario>

          <Scenario
            title="Your PR fails CI or has a conflict"
            prompt={<PromptLink name="Your PR is blocked" onClick={onEditPrompts} />}
            mode={sc.driveCi.mode}
            modes={["off", "shadow", "on"]}
            onMode={(mode) => patch("driveCi", { mode })}
          >
            <div className="flex flex-wrap items-center gap-2 text-sm text-fg-secondary">
              Give up after
              <Num bound="maxAttempts" value={sc.driveCi.maxAttempts} onChange={(maxAttempts) => patch("driveCi", { maxAttempts })} unit="attempts" />
              on one PR, then hand it to you
            </div>
            <p className="mt-1 text-xs text-fg-faint">An attempt is one run that ends in a push; the count starts over once CI is green or someone else pushes.</p>
          </Scenario>

          <Scenario
            title="Reviewers comment on your PR"
            prompt={<PromptLink name="Reviewer comments" onClick={onEditPrompts} />}
            mode={sc.driveComments.mode}
            modes={["off", "shadow", "on"]}
            onMode={(mode) => patch("driveComments", { mode })}
          >
            <p className="text-xs text-fg-faint">
              Checks every open comment against the head: fixes the confirmed ones, answers in each thread, and asks you about business or design decisions. With failing CI
              or a conflict as well, your «PR is blocked» prompt runs instead.
            </p>
          </Scenario>
          <Locked>
            A PR of yours that an SDLC orchestrator run drives (its .sdlc/state names the PR) is left to that run: it reviews, fixes, answers the reviewers and merges itself.
          </Locked>
        </div>
      </Dimmed>
    </section>
  );
}

function LimitsSection({ agent, setAgent, inputCls }: SectionProps) {
  const l = agent.limits;
  const patch = (value: Partial<AgentSettings["limits"]>) => setAgent((a) => ({ ...a, limits: { ...a.limits, ...value } }));
  const quiet = (value: Partial<AgentSettings["limits"]["quietHours"]>) => patch({ quietHours: { ...l.quietHours, ...value } });
  return (
    <section className={cn(SECTION, "space-y-3")}>
      <h2 className={H2}>Limits</h2>
      <Dimmed off={!agent.enabled}>
        <div className="grid gap-3 sm:grid-cols-3">
          <NumField label="Runs at a time" bound="parallel" value={l.parallel} onChange={(parallel) => patch({ parallel })} />
          <NumField label="Runs per day" bound="perDay" value={l.perDay} onChange={(perDay) => patch({ perDay })} />
          <NumField label="Stop a run after" bound="maxMinutes" value={l.maxMinutes} unit="min" onChange={(maxMinutes) => patch({ maxMinutes })} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Check checked={l.quietHours.enabled} onChange={(enabled) => quiet({ enabled })} title="Quiet hours — start nothing new between" />
          <input type="time" value={l.quietHours.from} disabled={!l.quietHours.enabled} onChange={(e) => e.target.value && quiet({ from: e.target.value })} className={cn(inputCls, "mt-0 w-28")} />
          <span className="text-sm text-fg-subtle">and</span>
          <input type="time" value={l.quietHours.to} disabled={!l.quietHours.enabled} onChange={(e) => e.target.value && quiet({ to: e.target.value })} className={cn(inputCls, "mt-0 w-28")} />
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm text-fg-secondary">
          Suggest switching a scenario from Shadow to On after
          <Num bound="promoteAfter" value={l.promoteAfter} onChange={(promoteAfter) => patch({ promoteAfter })} unit="results accepted unchanged" />
        </div>
      </Dimmed>
    </section>
  );
}

const RUN_KIND_LABEL: Record<AgentRunKind, string> = {
  review: "Review",
  brief: "Brief",
  rereview: "Re-review",
  drive: "Drive to green",
  afterMerge: "After merging",
};

function PermissionsSection({ agent, setAgent, inputCls }: SectionProps) {
  const kinds = Object.keys(RUN_KIND_LABEL) as AgentRunKind[];
  const [kind, setKind] = useState<AgentRunKind>("review");
  const [text, setText] = useState<Record<AgentRunKind, string>>(() => {
    const t = {} as Record<AgentRunKind, string>;
    for (const k of kinds) t[k] = agent.permissions.tools[k].join("\n");
    return t;
  });
  const setTools = (value: string) => {
    setText((t) => ({ ...t, [kind]: value }));
    setAgent((a) => ({ ...a, permissions: { ...a.permissions, tools: { ...a.permissions.tools, [kind]: lines(value) } } }));
  };
  const isDefault = lines(text[kind]).join("\n") === DEFAULT_AGENT_TOOLS[kind].join("\n");
  return (
    <section className={cn(SECTION, "space-y-3")}>
      <h2 className={H2}>Permissions</h2>
      <Dimmed off={!agent.enabled}>
        <Field label="Allowed tools for" hint="One rule per line, in Claude Code's --allowedTools syntax. Anything else the run tries is refused without asking.">
          <div className="mt-1 flex flex-wrap gap-1">
            {kinds.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setKind(k)}
                aria-pressed={kind === k}
                className={cn(
                  "rounded-md border px-2 py-0.5 text-xs",
                  kind === k ? "border-sky-600 bg-sky-500/15 font-medium text-sky-800 dark:text-sky-200" : "border-line-strong text-fg-muted hover:bg-elevated",
                )}
              >
                {RUN_KIND_LABEL[k]}
              </button>
            ))}
          </div>
          <textarea value={text[kind]} onChange={(e) => setTools(e.target.value)} rows={6} className={cn(inputCls, "font-mono text-xs")} />
          <button
            type="button"
            disabled={isDefault}
            onClick={() => setTools(DEFAULT_AGENT_TOOLS[kind].join("\n"))}
            className="mt-1 text-xs text-sky-700 hover:underline disabled:cursor-default disabled:text-fg-faint disabled:no-underline dark:text-sky-300"
          >
            {isDefault ? "These are the defaults" : `Reset ${RUN_KIND_LABEL[kind]} to the defaults`}
          </button>
          {kind === "drive" && (
            <span className="mt-1 block text-xs text-amber-700 dark:text-amber-300">
              Test commands (npm test, npm run …) are off by default: a test runs your repository&apos;s code, and the session can edit that code. Add them only if you accept that — CI checks every push either way, and nothing reaches the branch until the app has checked the commits.
            </span>
          )}
        </Field>
        <Check
          checked={agent.permissions.pushOwnBranch}
          onChange={(pushOwnBranch) => setAgent((a) => ({ ...a, permissions: { ...a.permissions, pushOwnBranch } }))}
          title="Allow pushing to your own PR's branch"
          hint="Needed to drive your PRs to green. Off makes those runs stop before the push and hand you the commit."
        />
        <Locked>Reviews run no code from the PR&apos;s repository, and its project settings, hooks and CLAUDE.md are not loaded. The agent never pushes to anyone else&apos;s branch and never runs with permission checks skipped.</Locked>
      </Dimmed>
    </section>
  );
}

function CompanionSection({ agent, setAgent }: SectionProps) {
  const patch = (value: Partial<AgentSettings["companion"]>) => setAgent((a) => ({ ...a, companion: { ...a.companion, ...value } }));
  return (
    <section className={cn(SECTION, "space-y-3")}>
      <h2 className={H2}>Companion</h2>
      <Dimmed off={!agent.enabled}>
        <Check
          checked={agent.companion.headerChip}
          onChange={(headerChip) => patch({ headerChip })}
          title="Show the agent in the header"
          hint="The ring of its plan, and what it is doing right now."
        />
        <Check
          checked={agent.companion.trayState}
          onChange={(trayState) => patch({ trayState })}
          title="Show the agent's state in the tray icon"
          hint="So it stays in sight while the window is hidden."
        />
      </Dimmed>
    </section>
  );
}

function NotificationsSection({ agent, setAgent }: SectionProps) {
  const patch = (value: Partial<AgentSettings["notifications"]>) =>
    setAgent((a) => ({ ...a, notifications: { ...a.notifications, ...value } }));
  return (
    <section className={cn(SECTION, "space-y-3")}>
      <h2 className={H2}>Agent notifications</h2>
      <Dimmed off={!agent.enabled}>
        <Check checked={agent.notifications.needsYou} onChange={(needsYou) => patch({ needsYou })} title="It needs a decision from you" />
        <Check checked={agent.notifications.failed} onChange={(failed) => patch({ failed })} title="A run failed" />
        <Check
          checked={agent.notifications.finished}
          onChange={(finished) => patch({ finished })}
          title="A run finished"
          hint="Usually noise: the header chip already shows it once."
        />
      </Dimmed>
    </section>
  );
}

function PolicySection({ agent, setAgent, inputCls }: SectionProps) {
  const patch = (value: Partial<AgentSettings["policy"]>) => setAgent((a) => ({ ...a, policy: { ...a.policy, ...value } }));
  return (
    <section className={cn(SECTION, "space-y-3")}>
      <h2 className={H2}>Policy</h2>
      <Dimmed off={!agent.enabled}>
        <Field label="Signature on everything the agent posts" hint="It can be reworded, not removed — left empty, the default comes back.">
          <input
            value={agent.policy.signature === DEFAULT_AGENT_SIGNATURE ? "" : agent.policy.signature}
            onChange={(e) => patch({ signature: e.target.value.trim() ? e.target.value : DEFAULT_AGENT_SIGNATURE })}
            placeholder={DEFAULT_AGENT_SIGNATURE}
            className={inputCls}
          />
        </Field>
        <div className="flex flex-wrap items-center gap-2 text-sm text-fg-secondary">
          Keep the agent&apos;s log for
          <Num bound="logRetentionDays" value={agent.policy.logRetentionDays} onChange={(logRetentionDays) => patch({ logRetentionDays })} unit="days" />
        </div>
      </Dimmed>
    </section>
  );
}

// --- small pieces, styled like the rest of the Settings screen ---

function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Greys a block out while the agent is off — still editable, so it can be set up before switching on. */
function Dimmed({ off, children }: { off: boolean; children: ReactNode }) {
  return <div className={cn("space-y-3", off && "opacity-60")}>{children}</div>;
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
    <div>
      <span className="block text-xs font-medium text-fg-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-fg-faint">{hint}</span>}
    </div>
  );
}

/** A number box that says what is wrong instead of taking a value out of bounds. */
function Num({ bound, value, unit, onChange }: { bound: AgentBoundKey; value: number; unit?: string; onChange: (v: number) => void }) {
  const { min, max } = AGENT_BOUNDS[bound];
  const [text, setText] = useState(String(value));
  const n = Number(text);
  const bad = text.trim() === "" || !Number.isInteger(n) || n < min || n > max;
  return (
    <span className="inline-flex flex-col">
      <span className="inline-flex items-center gap-1.5">
        <input
          value={text}
          inputMode="numeric"
          aria-invalid={bad}
          onChange={(e) => {
            setText(e.target.value);
            const v = Number(e.target.value);
            if (Number.isInteger(v) && v >= min && v <= max) onChange(v);
          }}
          className={cn(
            "w-20 rounded-md border bg-surface px-2 py-1 text-sm tabular-nums text-fg focus:outline-none",
            bad ? "border-red-500" : "border-line-strong focus:border-sky-600",
          )}
        />
        {unit && <span className="text-sm text-fg-subtle">{unit}</span>}
      </span>
      {bad && (
        <span className="mt-0.5 text-[11px] text-red-700 dark:text-red-300">
          A whole number from {min} to {max}
        </span>
      )}
    </span>
  );
}

function NumField(props: { label: string; bound: AgentBoundKey; value: number; unit?: string; onChange: (v: number) => void }) {
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

const MODE_LABEL: Record<AgentMode, string> = { off: "Off", shadow: "Shadow", on: "On" };

function Scenario({
  title,
  prompt,
  mode,
  modes,
  onMode,
  onLabel,
  children,
}: {
  title: string;
  prompt: ReactNode;
  mode: AgentMode;
  modes: AgentMode[];
  onMode: (m: AgentMode) => void;
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
                    : "bg-elevated font-medium text-fg"
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
