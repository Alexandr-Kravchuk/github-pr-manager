// Barely-visible snowflakes across the whole header — pure decoration.
//
// They fall only while the pointer is over the header (`.snow-host:hover`
// in styles.css) and stand still otherwise. A paused animation produces no
// frames; one that always ran would keep the GPU compositor busy for as long
// as the app runs, hidden window included (see "No always-running animation"
// in AGENTS.md).

/** The header with its toolbar is about twice as tall as the title row the flakes started in. */
const FLAKE_COUNT = 60;

/** Deterministic scatter (x, y, size, rotation) so the layout is the same on every render. */
const FLAKES: ReadonlyArray<readonly [number, number, number, number]> = (() => {
  const out: Array<readonly [number, number, number, number]> = [];
  let seed = 7;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < FLAKE_COUNT; i++) {
    // Even spread along the width with jitter, so no clumps and no gaps.
    const x = (i + 0.2 + rand() * 0.6) * (1600 / FLAKE_COUNT);
    out.push([x, 8 + rand() * 74, 5 + rand() * 7, rand() * 60]);
  }
  return out;
})();

/** One six-armed flake of radius `r`, each arm with a pair of short side twigs, centred on (0, 0). */
function Flake({ r, rot }: { r: number; rot: number }) {
  const twig = r * 0.35;
  return (
    <g transform={`rotate(${rot})`}>
      {[0, 60, 120].map((a) => (
        <line key={a} x1={-r} y1={0} x2={r} y2={0} transform={`rotate(${a})`} />
      ))}
      {[0, 60, 120, 180, 240, 300].map((a) => (
        <path
          key={a}
          d={`M${r * 0.55} 0 l${twig * 0.7} ${-twig} M${r * 0.55} 0 l${twig * 0.7} ${twig}`}
          transform={`rotate(${a})`}
        />
      ))}
    </g>
  );
}

/** A flake as its own little SVG, centred on `top` within its falling column. */
function FlakeIcon({ r, rot, top }: { r: number; rot: number; top: string }) {
  const box = r + 1;
  return (
    <svg
      viewBox={`${-box} ${-box} ${box * 2} ${box * 2}`}
      width={box * 2.5}
      height={box * 2.5}
      className="absolute left-0 -translate-x-1/2 -translate-y-1/2"
      style={{ top }}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.1}
      strokeLinecap="round"
    >
      <Flake r={r} rot={rot} />
    </svg>
  );
}

/**
 * One falling column: an HTML element as tall as the strip, so its
 * `translateY(100%)` is exactly one strip height. It holds the flake twice,
 * one strip apart — the lower copy leaves while the upper one takes its exact
 * place, so a cycle paused at any point still shows a full sky, and at rest
 * (offset 0) the picture is the static scatter. Each column is an HTML element
 * rather than an SVG `<g>`: Chrome moves an HTML element's transform on the
 * compositor, while a transform inside an SVG repaints the whole SVG per frame
 * (~20% GPU while hovering, measured, against a few % this way).
 */
function FallingFlake({ x, y, r, rot, i }: { x: number; y: number; r: number; rot: number; i: number }) {
  const top = (y / 90) * 100;
  // Derived from the index, not from `rand`, so the scatter stays as it was.
  const style = {
    left: `${(x / 1600) * 100}%`,
    "--snow-dur": `${7 + ((i * 37) % 7)}s`,
    "--snow-sway": `${((i * 53) % 13) - 6}px`,
  } as React.CSSProperties;
  return (
    <div className="snow-fall absolute inset-y-0" style={style}>
      <FlakeIcon r={r} rot={rot} top={`${top}%`} />
      <FlakeIcon r={r} rot={rot} top={`${top - 100}%`} />
    </div>
  );
}

export function Snowflakes() {
  return (
    <div
      aria-hidden
      // -z-10 inside the sticky header's stacking context: above the header's
      // own background, below the title, stats and buttons.
      className="pointer-events-none absolute inset-0 -z-10 overflow-hidden text-fg opacity-[0.07]"
    >
      {FLAKES.map(([x, y, r, rot], i) => (
        <FallingFlake key={i} x={x} y={y} r={r} rot={rot} i={i} />
      ))}
    </div>
  );
}
