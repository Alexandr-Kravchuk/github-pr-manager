// Barely-visible snowflakes behind the header's title row — pure decoration.
//
// Deliberately STATIC: a falling-snow effect would need an `infinite` CSS
// animation, which keeps the GPU compositor busy for as long as the app runs,
// hidden window included (see "No always-running animation" in AGENTS.md).

/** Deterministic scatter (x, y, size, rotation) so the layout is the same on every render. */
const FLAKES: ReadonlyArray<readonly [number, number, number, number]> = (() => {
  const out: Array<readonly [number, number, number, number]> = [];
  let seed = 7;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < 34; i++) {
    // Even spread along the width with jitter, so no clumps and no gaps.
    const x = (i + 0.2 + rand() * 0.6) * (1600 / 34);
    out.push([x, 8 + rand() * 74, 5 + rand() * 7, rand() * 60]);
  }
  return out;
})();

/** One six-armed flake of radius `r`, each arm with a pair of short side twigs. */
function Flake({ x, y, r, rot }: { x: number; y: number; r: number; rot: number }) {
  const twig = r * 0.35;
  return (
    <g transform={`translate(${x} ${y}) rotate(${rot})`}>
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

export function Snowflakes() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 1600 90"
      preserveAspectRatio="xMidYMid slice"
      // -z-10 inside the sticky header's stacking context: above the header's
      // own background, below the title, stats and buttons.
      className="pointer-events-none absolute inset-y-0 -left-4 -right-4 -z-10 h-full w-[calc(100%+2rem)] text-fg opacity-[0.07]"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.1}
      strokeLinecap="round"
    >
      {FLAKES.map(([x, y, r, rot], i) => (
        <Flake key={i} x={x} y={y} r={r} rot={rot} />
      ))}
    </svg>
  );
}
