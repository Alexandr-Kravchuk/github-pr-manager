// Fetches the header's weather from Open-Meteo for the city set in Settings,
// or for the coordinates the user allowed once (main/weather-location.ts).
//
// The renderer asks often (on start, every few minutes, on leaving Settings);
// the answer is cached here so that costs nothing: a good answer for 30 min,
// a failure for 5 — the sky changes slowly, and a city that is not found
// will not be found a second later either. The coordinates are kept per city
// for the app run, so a refresh is one request, not two.

import type { WeatherStatus } from "../shared/types";
import { forecastUrl, geocodeUrl, parseCurrent, parseGeocode, splitCity, type GeoPlace } from "../shared/weather";

export const WEATHER_TTL_MS = 30 * 60_000;
export const WEATHER_ERROR_TTL_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

export type FetchJson = (url: string) => Promise<unknown>;

/** Coordinates from the one-time geolocation: no geocoding, the place is "Your location". */
export interface WeatherCoords {
  latitude: number;
  longitude: number;
}

export const LOCATION_PLACE = "Your location";

export interface WeatherService {
  get(where: string | WeatherCoords): Promise<WeatherStatus>;
}

/** Plain GET with a timeout. No cookies, no identifying headers: only the URL goes out. */
export const defaultFetchJson: FetchJson = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Open-Meteo answered HTTP ${res.status}`);
  return res.json();
};

export function createWeatherService(deps: { fetchJson?: FetchJson; now?: () => number } = {}): WeatherService {
  const fetchJson = deps.fetchJson ?? defaultFetchJson;
  const now = deps.now ?? Date.now;
  const places = new Map<string, GeoPlace>();
  let cached: { city: string; status: WeatherStatus; until: number } | null = null;
  // One request at a time per city: several callers asking together share it.
  let inflight: { city: string; promise: Promise<WeatherStatus> } | null = null;

  const fetchFor = async (city: string, coords: WeatherCoords | null): Promise<WeatherStatus> => {
    try {
      let geo = coords ? { place: LOCATION_PLACE, ...coords } : places.get(city);
      if (!geo) {
        const { name, hint } = splitCity(city);
        const found = parseGeocode(await fetchJson(geocodeUrl(name)), hint);
        if (!found) return { state: "error", message: `"${city}" was not found.` };
        geo = found;
        places.set(city, geo);
      }
      const current = parseCurrent(await fetchJson(forecastUrl(geo.latitude, geo.longitude)));
      if (!current) return { state: "error", message: "Open-Meteo sent an answer without the current weather." };
      return { state: "ok", ...current, place: geo.place, fetchedAt: now(), ...(coords ? { fromLocation: true } : {}) };
    } catch (e) {
      return { state: "error", message: (e as Error).message || "The weather could not be loaded." };
    }
  };

  return {
    async get(where) {
      const coords = typeof where === "string" ? null : where;
      // The cache key: the city, or the coordinates (never a valid city name).
      const city = typeof where === "string" ? where.trim() : `@${where.latitude},${where.longitude}`;
      if (!city) return { state: "off" };
      const previous = cached?.city === city ? cached : null;
      if (previous && now() < previous.until) return previous.status;
      if (inflight?.city === city) return inflight.promise;
      const promise = fetchFor(city, coords).then((fresh) => {
        // A failure keeps showing the last good weather of the same place — a
        // dropped connection is no reason for the header's icon to vanish —
        // but is retried on the short TTL either way.
        const keep = fresh.state === "error" && previous?.status.state === "ok" ? previous.status : fresh;
        cached = { city, status: keep, until: now() + (fresh.state === "ok" ? WEATHER_TTL_MS : WEATHER_ERROR_TTL_MS) };
        return keep;
      });
      inflight = { city, promise };
      try {
        return await promise;
      } finally {
        if (inflight?.promise === promise) inflight = null;
      }
    },
  };
}
