// The location the user chose in Settings › Header weather ("Use my
// location"): the coordinates main/locate.ts got from the OS, kept in
// userData/weather-location.json. Its own file, not settings.json: it is
// saved by the button right away, while settings.json is rewritten by Save.
// Nothing asks for the location on its own.

import fs from "node:fs";
import path from "node:path";

export interface SavedLocation {
  latitude: number;
  longitude: number;
}

const inRange = (v: unknown, limit: number): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= limit;

/** null when none is saved or the file is not a valid location. */
export function readSavedLocation(file: string): SavedLocation | null {
  try {
    const obj = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<SavedLocation>;
    return inRange(obj.latitude, 90) && inRange(obj.longitude, 180) ? { latitude: obj.latitude, longitude: obj.longitude } : null;
  } catch {
    return null;
  }
}

/** Rounded to ~1 km: the weather needs no more, so no more is stored or sent. */
export function saveLocation(file: string, loc: SavedLocation): SavedLocation {
  const round = (n: number) => Math.round(n * 100) / 100;
  const saved = { latitude: round(loc.latitude), longitude: round(loc.longitude) };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(saved, null, 2)}\n`, "utf8");
  return saved;
}

export function forgetLocation(file: string): void {
  fs.rmSync(file, { force: true });
}
