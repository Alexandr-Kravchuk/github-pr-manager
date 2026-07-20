/**
 * A short two-tone "ping" via the Web Audio API. Synthesized rather than a
 * bundled/`data:` audio file so it needs no asset and sidesteps the strict
 * packaged-app CSP (`default-src 'self'`, which forbids `data:` media).
 *
 * Fired only when the user wants a sound but has native OS notifications turned
 * off; when native is on, the OS notification plays its own sound. The
 * BrowserWindow sets `autoplayPolicy: "no-user-gesture-required"` so this can
 * play without a prior click.
 */

let ctx: AudioContext | null = null;

export function playNotifySound(): void {
  try {
    const AudioCtor = window.AudioContext;
    if (!AudioCtor) return;
    ctx ??= new AudioCtor();
    if (ctx.state === "suspended") void ctx.resume();

    const now = ctx.currentTime;
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    // Fast attack, gentle decay — a soft chime rather than a lingering beep.
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.15, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);

    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, now); // A5
    osc.frequency.setValueAtTime(1174.66, now + 0.12); // D6 — a rising two-tone
    osc.connect(gain);
    osc.start(now);
    osc.stop(now + 0.45);
  } catch {
    /* audio unavailable — a missing ping is never worth surfacing */
  }
}
