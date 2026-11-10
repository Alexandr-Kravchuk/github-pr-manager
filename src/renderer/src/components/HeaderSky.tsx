// The header's sky — barely visible, pure decoration, drawn from the current
// weather in the city set in Settings (main/weather.ts): snow, rain, a
// thunderstorm, clouds, fog, the sun or a starry night. With no city, or
// before the first answer, it snows, as the header always did.
//
// Everything moves only while the pointer is over the header (`.sky-host:hover`
// in styles.css) and stands still otherwise. A paused animation produces no
// frames; one that always ran would keep the GPU compositor busy for as long
// as the app runs, hidden window included (see "No always-running animation"
// in AGENTS.md). At rest each sky is a still picture of itself.

import type { CSSProperties, ReactNode } from "react";

import type { WeatherKind, WeatherStatus } from "../../../shared/types";

/** The strip the scatter is laid out on; positions become percentages of it. */
const W = 1600;
const H = 90;

/** Deterministic scatter (x, y, a, b in 0..1) so the layout is the same on every render. */
function scatter(count: number, seed: number): ReadonlyArray<readonly [number, number, number, number]> {
  const out: Array<readonly [number, number, number, number]> = [];
  let s = seed;
  const rand = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
  for (let i = 0; i < count; i++) {
    // Even spread along the width with jitter, so no clumps and no gaps.
    const x = (i + 0.2 + rand() * 0.6) * (W / count);
    out.push([x, 8 + rand() * 74, rand(), rand()]);
  }
  return out;
}

const pctX = (x: number) => `${(x / W) * 100}%`;
const pctY = (y: number) => `${(y / H) * 100}%`;

/** The layer behind the header's content; `opacity` sets how faint the sky is. */
function Layer({ opacity, children }: { opacity: number; children: ReactNode }) {
  return (
    <div
      aria-hidden
      // -z-10 inside the sticky header's stacking context: above the header's
      // own background, below the title, stats and buttons.
      className="pointer-events-none absolute inset-0 -z-10 overflow-hidden text-fg"
      style={{ opacity }}
    >
      {children}
    </div>
  );
}

/**
 * One falling column: an HTML element as tall as the strip, so its
 * `translateY(100%)` is exactly one strip height. It holds its item twice,
 * one strip apart — the lower copy leaves while the upper one takes its exact
 * place, so a cycle paused at any point still shows a full sky, and at rest
 * (offset 0) the picture is the static scatter. Each column is an HTML element
 * rather than an SVG `<g>`: Chrome moves an HTML element's transform on the
 * compositor, while a transform inside an SVG repaints the whole SVG per frame
 * (~20% GPU while hovering, measured, against a few % this way).
 */
function FallingColumn(props: { x: number; y: number; dur: number; sway: number; item: (top: string) => ReactNode }) {
  const style = {
    left: pctX(props.x),
    "--sky-dur": `${props.dur}s`,
    "--sky-sway": `${props.sway}px`,
  } as CSSProperties;
  const top = (props.y / H) * 100;
  return (
    <div className="sky-anim sky-fall absolute inset-y-0" style={style}>
      {props.item(`${top}%`)}
      {props.item(`${top - 100}%`)}
    </div>
  );
}

/** The same trick sideways: a row as wide as the strip, its item twice, one strip width apart. */
function DriftingRow(props: { x: number; y: number; dur: number; item: (left: string, top: string) => ReactNode }) {
  const left = (props.x / W) * 100;
  return (
    <div className="sky-anim sky-drift absolute inset-0" style={{ "--sky-dur": `${props.dur}s` } as CSSProperties}>
      {props.item(`${left}%`, pctY(props.y))}
      {props.item(`${left - 100}%`, pctY(props.y))}
    </div>
  );
}

// ── Snow ───────────────────────────────────────────────────────────────────

const FLAKES = scatter(60, 7);

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

function Snow() {
  return (
    <Layer opacity={0.07}>
      {FLAKES.map(([x, y, a, b], i) => {
        const r = 5 + a * 7;
        const rot = b * 60;
        // Derived from the index, not from the scatter, so the layout stays as it was.
        return (
          <FallingColumn
            key={i}
            x={x}
            y={y}
            dur={7 + ((i * 37) % 7)}
            sway={((i * 53) % 13) - 6}
            item={(top) => <FlakeIcon key={top} r={r} rot={rot} top={top} />}
          />
        );
      })}
    </Layer>
  );
}

// ── Rain and thunder ─────────────────────────────────────────────────────

const DROPS = scatter(90, 11);

function Rain({ storm }: { storm: boolean }) {
  return (
    <Layer opacity={storm ? 0.16 : 0.13}>
      {DROPS.map(([x, y, a], i) => {
        const len = 7 + a * 9;
        return (
          <FallingColumn
            key={i}
            x={x}
            y={y}
            dur={0.7 + ((i * 29) % 5) * 0.1}
            sway={0}
            item={(top) => (
              <span
                key={top}
                className="absolute left-0 w-px -translate-y-1/2 rotate-[14deg] rounded-full bg-current"
                style={{ top, height: len }}
              />
            )}
          />
        );
      })}
      {storm && (
        <span
          className="sky-anim sky-flash absolute inset-0 bg-current"
          style={{ "--sky-dur": "7s" } as CSSProperties}
        />
      )}
    </Layer>
  );
}

// ── Clouds and fog ────────────────────────────────────────────────────────

const CLOUDS = scatter(7, 23);

function CloudShape({ width, left, top }: { width: number; left: string; top: string }) {
  return (
    <svg
      viewBox="0 0 100 44"
      width={width}
      className="absolute -translate-y-1/2"
      style={{ left, top }}
      fill="currentColor"
    >
      <path d="M18 40 a14 14 0 0 1 2-28 a20 20 0 0 1 36-6 a16 16 0 0 1 26 10 a12 12 0 0 1 0 24 z" />
    </svg>
  );
}

function Clouds() {
  return (
    <Layer opacity={0.06}>
      {CLOUDS.map(([x, y, a], i) => (
        <DriftingRow
          key={i}
          x={x}
          y={y - 10}
          dur={90 + ((i * 41) % 60)}
          item={(left, top) => <CloudShape key={left} width={90 + a * 110} left={left} top={top} />}
        />
      ))}
    </Layer>
  );
}

const FOG_BANDS: ReadonlyArray<readonly [number, number, number]> = [
  // y (of H), thickness (px), seconds per strip width
  [20, 34, 160],
  [50, 44, 220],
  [80, 38, 190],
];

function Fog() {
  // A long, gently wavy band as wide as the strip; two copies make it endless.
  const band = (h: number) => (left: string, top: string) => (
    <svg
      key={left}
      viewBox="0 0 400 20"
      preserveAspectRatio="none"
      // The blur is painted once: only the row's transform moves afterwards.
      className="absolute w-full -translate-y-1/2 blur-md"
      style={{ left, top, height: h }}
      fill="currentColor"
    >
      <path d="M0 6 Q50 0 100 6 T200 6 T300 6 T400 6 V14 Q350 20 300 14 T200 14 T100 14 T0 14 Z" />
    </svg>
  );
  return (
    <Layer opacity={0.08}>
      {FOG_BANDS.map(([y, h, dur], i) => (
        <DriftingRow key={i} x={(i * 530) % W} y={y} dur={dur} item={band(h)} />
      ))}
    </Layer>
  );
}

// ── Clear sky: the sun by day, stars by night ───────────────────────────────

/**
 * The sky's one big body sits in the gap between the title and the controls
 * — the first row only: the search field fills the second from edge to edge.
 */
const BODY_X = "46%";
const BODY_Y = "30px";

const GLINTS = scatter(18, 31);

function Sun() {
  return (
    <Layer opacity={0.1}>
      <div className="absolute -translate-x-1/2 -translate-y-1/2" style={{ left: BODY_X, top: BODY_Y }}>
        {/* The rays turn on their own HTML layer; the disc stays put. */}
        <svg viewBox="-40 -40 80 80" width={80} height={80} className="sky-anim sky-spin block" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
          {Array.from({ length: 12 }, (_, i) => (
            <line key={i} x1={0} y1={-22} x2={0} y2={i % 2 ? -30 : -36} transform={`rotate(${i * 30})`} />
          ))}
        </svg>
        <svg viewBox="-40 -40 80 80" width={80} height={80} className="absolute inset-0" fill="currentColor">
          <circle r={15} />
        </svg>
      </div>
      {GLINTS.map(([x, y, a, b], i) => (
        <Twinkle key={i} x={x} y={y} dur={3 + a * 4} delay={-b * 6}>
          <svg viewBox="-5 -5 10 10" width={8 + a * 6} height={8 + a * 6} fill="currentColor">
            <path d="M0 -5 L1 -1 L5 0 L1 1 L0 5 L-1 1 L-5 0 L-1 -1 Z" />
          </svg>
        </Twinkle>
      ))}
    </Layer>
  );
}

function Twinkle(props: { x: number; y: number; dur: number; delay: number; children: ReactNode }) {
  const style = {
    left: pctX(props.x),
    top: pctY(props.y),
    "--sky-dur": `${props.dur}s`,
    "--sky-delay": `${props.delay}s`,
  } as CSSProperties;
  return (
    <span className="sky-anim sky-twinkle absolute -translate-x-1/2 -translate-y-1/2" style={style}>
      {props.children}
    </span>
  );
}

const STARS = scatter(80, 43);

function Night() {
  return (
    <Layer opacity={0.2}>
      <svg
        viewBox="-20 -20 40 40"
        width={36}
        height={36}
        className="absolute -translate-x-1/2 -translate-y-1/2"
        style={{ left: BODY_X, top: BODY_Y }}
        fill="currentColor"
      >
        {/* A crescent: the disc minus a disc shifted to the upper right. */}
        <path d="M6 -15 A16 16 0 1 0 15 6 A12 12 0 1 1 6 -15 Z" />
      </svg>
      {STARS.map(([x, y, a, b], i) => (
        <Twinkle key={i} x={x} y={y} dur={2.5 + a * 4} delay={-b * 6}>
          <span className="block rounded-full bg-current" style={{ width: 1.5 + a * 2, height: 1.5 + a * 2 }} />
        </Twinkle>
      ))}
    </Layer>
  );
}

// ── Picking the sky ────────────────────────────────────────────────────────

const SKY: Record<WeatherKind, () => ReactNode> = {
  snow: () => <Snow />,
  rain: () => <Rain storm={false} />,
  thunder: () => <Rain storm />,
  clouds: () => <Clouds />,
  fog: () => <Fog />,
  "clear-day": () => <Sun />,
  "clear-night": () => <Night />,
};

/** The sky for the weather; off, failed or not yet known → snow. */
export function HeaderSky({ weather }: { weather: WeatherStatus | null }) {
  const kind: WeatherKind = weather?.state === "ok" ? weather.kind : "snow";
  return <>{(SKY[kind] ?? SKY.snow)()}</>;
}
