// The app's own mermaid, loaded on first use — it is big, and most sessions
// never show a diagram. It draws the PR agent's diagrams on a card, and parses
// them for main, which can't: a flowchart needs a DOM. `securityLevel:
// "strict"` keeps every label plain text and drops click handlers, on top of
// the guard the diagrams already passed (shared/agent-diagrams.ts).

import DOMPurify from "dompurify";

type Mermaid = (typeof import("mermaid"))["default"];

let loading: Promise<Mermaid> | null = null;
let seq = 0;

/**
 * Labels as SVG text, not HTML in a <foreignObject>: the output is then plain
 * SVG, which the sanitizer below keeps whole — HTML inside a <foreignObject>
 * it empties, and the flowchart's boxes came out with no words in them.
 */
const BASE = { startOnLoad: false, securityLevel: "strict", htmlLabels: false, flowchart: { htmlLabels: false } } as const;

function load(): Promise<Mermaid> {
  loading ??= import("mermaid").then((m) => {
    m.default.initialize(BASE);
    return m.default;
  });
  return loading;
}

/** Whether each source parses — what main asks before a diagram may be posted. */
export async function parseDiagrams(sources: readonly string[]): Promise<boolean[]> {
  const mermaid = await load();
  const out: boolean[] = [];
  for (const source of sources) {
    try {
      out.push((await mermaid.parse(source, { suppressErrors: true })) !== false);
    } catch {
      out.push(false);
    }
  }
  return out;
}

/**
 * The diagram as SVG markup, in the app's light or dark theme; throws when it
 * doesn't parse. Sanitized once more on the way out: it is model output drawn
 * from a PR's text, about to go into the page that holds `window.api`.
 */
export async function renderDiagram(source: string): Promise<string> {
  const mermaid = await load();
  const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  mermaid.initialize({ ...BASE, theme: dark ? "dark" : "default" });
  seq += 1;
  const { svg } = await mermaid.render(`prd-diagram-${seq}`, source);
  // SVG only: no HTML, no scripts or handlers, no links.
  return DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ["a", "foreignObject"] });
}
