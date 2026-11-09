import { useEffect, useState } from "react";

// Node-free — value-imported for the legend, the same words the posted comment carries.
import { DIAGRAM_LEGEND, type AgentDiagram } from "../../../shared/agent-diagrams";
import type { AgentItemDiagrams } from "../../../shared/types";
import { cn } from "../format";
import { renderDiagram } from "../mermaid";

const LINK = "text-xs text-sky-700 hover:underline dark:text-sky-300";

/**
 * A run's diagrams on its Board card, folded until asked for: mermaid is
 * loaded and the SVG drawn only once you open them.
 */
export function AgentDiagrams({ diagrams, posts }: { diagrams: AgentItemDiagrams; posts: boolean }) {
  const [open, setOpen] = useState(false);
  const n = diagrams.list.length;
  if (n === 0) {
    if (diagrams.existingUrl) {
      return (
        <div className="mt-1.5 text-xs text-fg-faint">
          The PR has a Mermaid diagram already, so none was drawn ·{" "}
          <button type="button" className={LINK} onClick={() => void window.api.openExternal(diagrams.existingUrl!).catch(() => {})}>
            open it ↗
          </button>
        </div>
      );
    }
    return diagrams.note ? <div className="mt-1.5 text-xs text-fg-faint">No diagrams: {diagrams.note}</div> : null;
  }
  return (
    <div>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className={cn(LINK, "mt-1.5")}>
        {open ? "Hide the diagrams" : `▸ ${n === 1 ? "The diagram" : `The ${n} diagrams`}`}
      </button>
      {open && (
        <div className="mt-1.5 space-y-3">
          <p className="text-[11px] text-fg-faint">
            {DIAGRAM_LEGEND}
            {posts ? " They go out with the review, as one comment." : ""}
            {diagrams.note ? ` ${diagrams.note}.` : ""}
          </p>
          {diagrams.list.map((d, i) => (
            <OneDiagram key={`${i}:${d.title}`} diagram={d} posts={posts} />
          ))}
        </div>
      )}
    </div>
  );
}

function OneDiagram({ diagram, posts }: { diagram: AgentDiagram; posts: boolean }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);
  // A Board column is narrow: fitted, a wide diagram's words get small — full size scrolls instead.
  const [full, setFull] = useState(false);
  const natural = svg ? Number(/viewBox="[-\d.]+\s+[-\d.]+\s+([\d.]+)/.exec(svg)?.[1] ?? 0) : 0;
  useEffect(() => {
    let alive = true;
    setSvg(null);
    setBroken(false);
    renderDiagram(diagram.source).then(
      (markup) => alive && setSvg(markup),
      () => alive && setBroken(true),
    );
    return () => {
      alive = false;
    };
  }, [diagram.source]);
  return (
    <figure>
      <figcaption className="flex items-baseline justify-between gap-2 text-xs font-medium text-fg-secondary">
        {diagram.title}
        {svg && natural > 0 && (
          <button type="button" onClick={() => setFull(!full)} className={cn(LINK, "font-normal")}>
            {full ? "Fit to the card" : "Full size"}
          </button>
        )}
      </figcaption>
      {broken ? (
        <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">It doesn&apos;t render{posts ? ", so it won't be posted" : ""}.</p>
      ) : svg ? (
        <div className="agent-diagram mt-1 overflow-x-auto rounded border border-line bg-surface p-2">
          {/* mermaid's SVG under securityLevel "strict", sanitized again to SVG only (renderDiagram). */}
          <div style={full && natural > 0 ? { width: `${natural}px` } : undefined} dangerouslySetInnerHTML={{ __html: svg }} />
        </div>
      ) : (
        <p className="mt-1 text-xs text-fg-faint">Drawing…</p>
      )}
    </figure>
  );
}
