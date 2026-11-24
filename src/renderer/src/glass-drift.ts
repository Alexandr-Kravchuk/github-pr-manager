// The glassmorphism look's backdrop blobs drift, slowly. Not a CSS
// animation: an animation, however slow, has the compositor produce a frame
// every vsync, and every frosted card above the blobs re-blurs on each one
// (AGENTS.md, "No always-running animation in the renderer"). Here the blobs
// move once a second by a few pixels — too little to see as a jump through a
// gradient that soft — so the page repaints once a second, and not at all
// while the window is hidden or unfocused, another look is on or the OS asks
// for reduced motion.
//
// The positions are a function of the drift's own clock, not of the wall
// clock: it advances only while the blobs move and is kept in localStorage,
// so a pause, a hidden window or a restart resumes exactly where the blobs
// stopped. Switching to this look from another starts the path over.

const STEP_MS = 1000;

/** A blob's resting spot (the static look's) and its swing, in % of the window. */
interface DriftPath {
  x: number;
  y: number;
  ax: number; // swing, in % of the window
  ay: number;
  px: number; // period of a full swing, in seconds
  py: number;
  phase: number;
}

const BLOBS: readonly DriftPath[] = [
  { x: 8, y: 12, ax: 11, ay: 9, px: 160, py: 130, phase: 0 },
  { x: 92, y: 18, ax: 10, ay: 11, px: 145, py: 175, phase: 1.7 },
  { x: 70, y: 95, ax: 12, ay: 8, px: 185, py: 150, phase: 3.1 },
  { x: 20, y: 85, ax: 9, ay: 10, px: 140, py: 165, phase: 4.4 },
];

/** Where each blob is `driftMs` into its path, as the custom properties the CSS reads. */
export function blobPositions(driftMs: number): Record<string, string> {
  const t = driftMs / 1000;
  const out: Record<string, string> = {};
  BLOBS.forEach((b, i) => {
    const x = b.x + b.ax * Math.sin((2 * Math.PI * t) / b.px + b.phase);
    const y = b.y + b.ay * Math.sin((2 * Math.PI * t) / b.py + b.phase * 1.3);
    out[`--b${i + 1}x`] = `${x.toFixed(2)}%`;
    out[`--b${i + 1}y`] = `${y.toFixed(2)}%`;
  });
  return out;
}

const CLOCK_KEY = "prd:glass-drift-ms";
/** Saved every few steps (and on every stop), not on each: a step is a second. */
const SAVE_EVERY_STEPS = 5;

let layer: HTMLDivElement | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let listening = false;
let reducedMotion: MediaQueryList | null = null;
/** How far along its path the drift is, in ms; null until read from storage. */
let driftMs: number | null = null;
let stepsSinceSave = 0;

function loadClock(): number {
  try {
    const n = Number(localStorage.getItem(CLOCK_KEY));
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

function saveClock(): void {
  stepsSinceSave = 0;
  if (driftMs === null) return;
  try {
    localStorage.setItem(CLOCK_KEY, String(Math.round(driftMs)));
  } catch {
    /* storage can be unavailable; the drift just starts over next time */
  }
}

/** Starts the path over — a switch to this look from another one. */
export function resetGlassDrift(): void {
  driftMs = 0;
  saveClock();
  paint();
}

function isGlass(): boolean {
  return document.documentElement.dataset.ui === "glassmorphism";
}

function paint(): void {
  if (!layer) return;
  if (driftMs === null) driftMs = loadClock();
  for (const [name, value] of Object.entries(blobPositions(driftMs))) {
    layer.style.setProperty(name, value);
  }
}

function step(): void {
  if (driftMs === null) driftMs = loadClock();
  driftMs += STEP_MS;
  paint();
  stepsSinceSave += 1;
  if (stepsSinceSave >= SAVE_EVERY_STEPS) saveClock();
}

function stop(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
  saveClock();
}

/** Start or stop the drift for the look and visibility in force now. */
export function syncGlassDrift(): void {
  if (!listening) {
    listening = true;
    document.addEventListener("visibilitychange", syncGlassDrift);
    // Electron runs with MacWebContentsOcclusion off, so a window covered by
    // other apps stays `!document.hidden`; losing focus is the signal left.
    window.addEventListener("focus", syncGlassDrift);
    window.addEventListener("blur", syncGlassDrift);
    // A quit from the tray may not blur the window first.
    window.addEventListener("pagehide", saveClock);
    reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;
    reducedMotion?.addEventListener?.("change", syncGlassDrift);
  }
  if (!isGlass()) {
    stop();
    layer?.remove();
    layer = null;
    return;
  }
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "glass-backdrop";
    layer.setAttribute("aria-hidden", "true");
    document.body.prepend(layer);
  }
  // Painted even while still, so the blobs stand where the drift stopped.
  paint();
  const still = document.hidden || !document.hasFocus() || reducedMotion?.matches === true;
  if (still) {
    stop();
    return;
  }
  if (timer === null) timer = setInterval(step, STEP_MS);
}
