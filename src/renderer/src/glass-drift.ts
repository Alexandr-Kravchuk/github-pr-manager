// The glassmorphism look's backdrop blobs drift, very slowly. Not a CSS
// animation: an animation, however slow, has the compositor produce a frame
// every vsync, and every frosted card above the blobs re-blurs on each one
// (AGENTS.md, "No always-running animation in the renderer"). Here the blobs
// move once a second by a few pixels — too little to see as a jump through a
// gradient that soft — so the page repaints once a second, and not at all
// while the window is hidden or unfocused, another look is on or the OS asks for reduced
// motion. The positions are a function of the clock, so a pause resumes where
// the path would be by now instead of jumping back.

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
  { x: 8, y: 12, ax: 9, ay: 7, px: 410, py: 330, phase: 0 },
  { x: 92, y: 18, ax: 8, ay: 9, px: 370, py: 450, phase: 1.7 },
  { x: 70, y: 95, ax: 10, ay: 6, px: 480, py: 390, phase: 3.1 },
  { x: 20, y: 85, ax: 7, ay: 8, px: 350, py: 420, phase: 4.4 },
];

/** Where each blob is at `nowMs`, as the custom properties the CSS reads. */
export function blobPositions(nowMs: number): Record<string, string> {
  const t = nowMs / 1000;
  const out: Record<string, string> = {};
  BLOBS.forEach((b, i) => {
    const x = b.x + b.ax * Math.sin((2 * Math.PI * t) / b.px + b.phase);
    const y = b.y + b.ay * Math.sin((2 * Math.PI * t) / b.py + b.phase * 1.3);
    out[`--b${i + 1}x`] = `${x.toFixed(2)}%`;
    out[`--b${i + 1}y`] = `${y.toFixed(2)}%`;
  });
  return out;
}

let layer: HTMLDivElement | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let listening = false;
let reducedMotion: MediaQueryList | null = null;

function isGlass(): boolean {
  return document.documentElement.dataset.ui === "glassmorphism";
}

function step(): void {
  if (!layer) return;
  for (const [name, value] of Object.entries(blobPositions(Date.now()))) {
    layer.style.setProperty(name, value);
  }
}

function stop(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
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
  const still = document.hidden || !document.hasFocus() || reducedMotion?.matches === true;
  if (still) {
    stop();
    return;
  }
  step();
  if (timer === null) timer = setInterval(step, STEP_MS);
}
