/**
 * PROTOTYPE — throwaway, not for main.
 *
 * Question: what should the PR agent look like on the dashboard?
 * Five structurally different layouts on the existing dashboard route,
 * switched by `?variant=A…E`, the tabs above them and the floating bar (← / →):
 *   A Inbox-first · B Triage split view · C Mission control board · D Focus queue
 *   · E Board as its own view (a fourth segment in the header's view switch).
 * Run: `npx vite --config vite.renderer.config.ts`, then open
 * `http://localhost:5173/?buddy=agent&variant=E` (the `agent` dev-mock fixtures).
 * Dev builds only — App.tsx mounts this behind `import.meta.env.DEV`.
 */
import { useCallback, useEffect, useState, type ComponentType, type ReactNode } from "react";
import { createPortal } from "react-dom";

import type { PullRequest } from "../../../../shared/types";
import { useAgentProto } from "./agent-model";
import { AgentSlotContext, AgentStatusLine, CompanionContext, type VariantProps } from "./agent-ui";
import { AgentPresence } from "./Companion";
import { setAgentVariant, useAgentVariant } from "./variant-store";
import { NAME as NAME_A, VariantA } from "./VariantA";
import { NAME as NAME_B, VariantB } from "./VariantB";
import { NAME as NAME_C, VariantC } from "./VariantC";
import { NAME as NAME_D, VariantD } from "./VariantD";
import { NAME as NAME_E, VariantE } from "./VariantE";

const VARIANTS: { key: string; name: string; about: string; tryIt: string; View: ComponentType<VariantProps> }[] = [
  {
    key: "A",
    name: NAME_A,
    View: VariantA,
    about:
      "Дашборд лишається як є. Над списком PR з'являється секція «Needs you»: лише рішення, що чекають на тебе, кожне з точною дією. На картках, де працює агент, унизу — рядок його статусу.",
    tryIt: "J / K — вибрати рядок · Enter — головна дія · L — відкласти · Activity — журнал дій агента",
  },
  {
    key: "B",
    name: NAME_B,
    View: VariantB,
    about:
      "Як пошта або Linear Triage. Карток немає: ліворуч один список PR за тим, хто має діяти (Needs you → агент працює → зроблено → решта), праворуч — деталі вибраного PR, рішення агента та його історія на цьому PR.",
    tryIt: "Клікни PR у списку або J / K · Enter — головна дія · L — відкласти",
  },
  {
    key: "C",
    name: NAME_C,
    View: VariantC,
    about:
      "Як Devin Agent Command Center або GitHub Agent HQ. У центрі — агент, а не PR: дошка його запусків за станом (у черзі → працює → чекає на тебе → зроблено), зверху режим агента й ліміти. Список PR згорнутий під дошкою.",
    tryIt: "Клікни картку, щоб розгорнути · On / Shadow / Paused — режим агента · Log — журнал",
  },
  {
    key: "D",
    name: NAME_D,
    View: VariantD,
    about:
      "Режим «розібрати чергу до нуля»: одне рішення на весь екран, далі наступне, поки черга не спорожніє. Нижче видно, що йде далі. Решта дашборду згорнута. Задуманий як режим на ранок, а не як постійний вигляд.",
    tryIt: "Enter — виконати · L — відкласти · J / K — наступне / попереднє · клік у «Up next» — перейти",
  },
  {
    key: "E",
    name: NAME_E,
    View: VariantE,
    about:
      "Канбан як окреме представлення: четверта іконка в перемикачі виглядів у хедері, поруч із Roomy / Cozy / Compact. У трьох звичних виглядах дашборд не змінюється (лише рядок статусу агента на картках). Board показує ті самі відфільтровані PR колонками: Idle → Queued → Working → Needs you → Done today.",
    tryIt:
      "Клікни іконку колонок у перемикачі виглядів угорі праворуч · розгорни Idle і перетягни PR у Queued (або «Hand to agent») · клік по картці — деталі й історія · компаньйон — у хедері поруч із заголовком: кільце = кроки плану, бейдж = скільки рішень чекає; клік відкриває легкий поповер (крок, живий рядок, поле «Tell the agent…», пауза, ⋯ — план і лог, Take over, Stop)",
  },
];

export function AgentPrototype({
  prs,
  renderList,
  boardView = false,
}: {
  prs: PullRequest[];
  renderList: (prs: PullRequest[]) => ReactNode;
  boardView?: boolean;
}) {
  const key = useAgentVariant() ?? "A";
  const agent = useAgentProto(prs);
  const at = Math.max(0, VARIANTS.findIndex((v) => v.key === key));
  const { View, name, about, tryIt } = VARIANTS[at];

  const pick = setAgentVariant;
  const go = useCallback(
    (delta: number) => pick(VARIANTS[(at + delta + VARIANTS.length) % VARIANTS.length].key),
    [at, pick],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);

  const slot = useCallback(
    (pr: PullRequest) => {
      const item = agent.byNumber.get(pr.number);
      return item ? <AgentStatusLine item={item} agent={agent} pr={pr} /> : null;
    },
    [agent],
  );

  // The companion's popover: closed by default — the header chip already says what the agent is doing.
  const [companion, setCompanion] = useState<{ open: boolean; focus: number | null }>({ open: false, focus: null });
  const openCompanion = useCallback((prNumber?: number) => setCompanion({ open: true, focus: prNumber ?? null }), []);
  const [presenceSlot, setPresenceSlot] = useState<HTMLElement | null>(null);
  useEffect(() => setPresenceSlot(document.getElementById("agent-presence-slot")), []);

  return (
    <CompanionContext.Provider value={openCompanion}>
    <AgentSlotContext.Provider value={slot}>
      {presenceSlot &&
        createPortal(
          <AgentPresence
            agent={agent}
            open={companion.open}
            focus={companion.focus}
            onToggle={() => setCompanion((c) => ({ open: !c.open, focus: null }))}
            onClose={() => setCompanion({ open: false, focus: null })}
            onFocus={(n) => setCompanion({ open: true, focus: n })}
          />,
          presenceSlot,
        )}
      <div>
      {/* Not part of any design: says which variant this is and what it tries. */}
      <div className="mb-4 rounded-lg border-2 border-dashed border-violet-500/60 bg-violet-500/[0.06] p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded bg-violet-600 px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-white">
            Прототип
          </span>
          <div role="tablist" aria-label="Prototype variant" className="inline-flex flex-wrap gap-1">
            {VARIANTS.map((v) => (
              <button
                key={v.key}
                type="button"
                role="tab"
                aria-selected={v.key === key}
                onClick={() => pick(v.key)}
                className={
                  v.key === key
                    ? "rounded-md border border-violet-600 bg-violet-600 px-2.5 py-1 text-xs font-semibold text-white"
                    : "rounded-md border border-violet-500/40 bg-surface px-2.5 py-1 text-xs font-medium text-violet-800 hover:bg-violet-500/10 dark:text-violet-200"
                }
              >
                {v.key} · {v.name}
              </button>
            ))}
          </div>
        </div>
        <h2 className="mt-2 text-base font-semibold text-violet-900 dark:text-violet-100">
          Варіант {key} — {name}
        </h2>
        <p className="mt-0.5 max-w-4xl text-sm text-fg-secondary">{about}</p>
        <p className="mt-1 text-xs text-fg-muted">Спробуй: {tryIt}</p>
      </div>
      <View agent={agent} prs={prs} renderList={renderList} boardView={boardView} />
      </div>
      <div className="fixed bottom-4 left-1/2 z-40 flex -translate-x-1/2 items-center gap-1 whitespace-nowrap rounded-full bg-zinc-900 px-1.5 py-1 text-xs text-white shadow-lg ring-1 ring-black/20 dark:bg-zinc-100 dark:text-zinc-900">
        <button type="button" aria-label="Previous variant" onClick={() => go(-1)} className="rounded-full px-2 py-0.5 hover:bg-white/15 dark:hover:bg-black/10">
          ←
        </button>
        <span className="px-1 font-semibold">
          {key} · {name}
        </span>
        <button type="button" aria-label="Next variant" onClick={() => go(1)} className="rounded-full px-2 py-0.5 hover:bg-white/15 dark:hover:bg-black/10">
          →
        </button>
        <span className="ml-1 border-l border-white/25 pl-2 pr-2 tabular-nums opacity-80 dark:border-black/20">
          needs you {agent.needsYou.length} · working {agent.working.length} · queued {agent.queued.length} · done{" "}
          {agent.done.length}
        </span>
      </div>
    </AgentSlotContext.Provider>
    </CompanionContext.Provider>
  );
}
