// Keeping the computer awake while the PR agent's runs work (Settings › Agent ›
// "Keep the computer awake while a run works"). The decision is here, with
// every outside call injected, so it is unit-tested without Electron; main.ts
// hands it `powerSaveBlocker` and `powerMonitor`.

export interface KeepAwakeDeps {
  /** Starts a blocker (`powerSaveBlocker.start("prevent-app-suspension")`) and returns its id. */
  start(): number;
  stop(id: number): void;
  /** `powerMonitor.isOnBatteryPower()`: on battery the computer may sleep as usual. */
  onBattery(): boolean;
  /** The setting as saved; read at most once per `settingTtlMs` while a run works. */
  setting(): boolean;
  now?: () => number;
  log?: (message: string) => void;
}

export interface KeepAwake {
  /** Called on every change of the agent's state: whether a run works now. */
  update(working: boolean): void;
  /** Whether a blocker is held. */
  held(): boolean;
}

/** How long a read of the setting is used before it is read again — turning it off mid-run takes effect within this. */
export const KEEP_AWAKE_SETTING_TTL_MS = 30_000;

/**
 * Holds one blocker while a run works on mains power with the setting on, and
 * releases it as soon as any of the three stops being true. The setting is
 * read only while a run works and on mains power, and then at most once per
 * `KEEP_AWAKE_SETTING_TTL_MS`: the agent reports a step per tool call, and
 * reading `settings.json` on each would be a disk read every quarter second. A
 * setting that can't be read counts as off.
 */
export function createKeepAwake(deps: KeepAwakeDeps, settingTtlMs = KEEP_AWAKE_SETTING_TTL_MS): KeepAwake {
  const now = deps.now ?? (() => Date.now());
  let id: number | null = null;
  let cached: { value: boolean; at: number } | null = null;
  const setting = (): boolean => {
    const t = now();
    if (!cached || t - cached.at >= settingTtlMs) {
      let value = false;
      try {
        value = deps.setting();
      } catch {
        value = false;
      }
      cached = { value, at: t };
    }
    return cached.value;
  };
  return {
    update(working) {
      const want = working && !deps.onBattery() && setting();
      if (want && id === null) {
        id = deps.start();
        deps.log?.("agent: keeping the computer awake while a run works");
      } else if (!want && id !== null) {
        deps.stop(id);
        id = null;
        deps.log?.("agent: the computer may sleep again");
      }
    },
    held: () => id !== null,
  };
}
