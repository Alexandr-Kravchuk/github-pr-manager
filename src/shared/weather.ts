// The weather behind the header: what Open-Meteo is asked and how its answer
// becomes one of the header's sky pictures. Node-free (see AGENTS.md) so the
// renderer can value-import the labels; the fetching lives in main/weather.ts.
//
// Open-Meteo needs no API key and no account. The only thing it learns is the
// city the user typed in Settings (and, through it, the coordinates) — the
// feature is off until a city is set.

import type { WeatherKind } from "./types";

export const GEOCODE_ENDPOINT = "https://geocoding-api.open-meteo.com/v1/search";
export const FORECAST_ENDPOINT = "https://api.open-meteo.com/v1/forecast";

/** What the header shows for each kind — in Settings and in the header's tooltip. */
export const WEATHER_LABEL: Record<WeatherKind, string> = {
  "clear-day": "Clear",
  "clear-night": "Clear night",
  clouds: "Cloudy",
  fog: "Fog",
  rain: "Rain",
  snow: "Snow",
  thunder: "Thunderstorm",
};

/**
 * WMO weather code (what Open-Meteo reports as `weather_code`) → sky picture.
 * 0–1 clear, 2–3 cloudy, 45/48 fog, 51–67 and 80–82 drizzle or rain, 71–77
 * and 85–86 snow, 95–99 thunderstorm. A code outside the table is treated as
 * cloudy: a sky the app does not recognise is more likely grey than clear.
 */
export function weatherKind(code: number, isDay: boolean): WeatherKind {
  if (code <= 1) return isDay ? "clear-day" : "clear-night";
  if (code === 45 || code === 48) return "fog";
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if (code >= 95 && code <= 99) return "thunder";
  return "clouds";
}

/**
 * "Kyiv" or "Kyiv, Ukraine". Open-Meteo matches the place name alone, so
 * anything after the first comma is kept apart to pick among same-named
 * places (Paris, France vs Paris, Texas).
 */
export function splitCity(input: string): { name: string; hint: string } {
  const [name = "", ...rest] = input.split(",");
  return { name: name.trim(), hint: rest.join(",").trim().toLowerCase() };
}

export function geocodeUrl(name: string): string {
  const q = new URLSearchParams({ name, count: "10", language: "en", format: "json" });
  return `${GEOCODE_ENDPOINT}?${q.toString()}`;
}

export function forecastUrl(latitude: number, longitude: number): string {
  const q = new URLSearchParams({
    latitude: latitude.toFixed(4),
    longitude: longitude.toFixed(4),
    current: "temperature_2m,weather_code,is_day",
  });
  return `${FORECAST_ENDPOINT}?${q.toString()}`;
}

export interface GeoPlace {
  /** "Kyiv, Ukraine" — the place Open-Meteo picked, as the user should see it. */
  place: string;
  latitude: number;
  longitude: number;
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * The first geocoding result whose country or region contains `hint` (any
 * result when there is no hint); null when nothing matches.
 */
export function parseGeocode(json: unknown, hint: string): GeoPlace | null {
  const results = (json as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return null;
  for (const r of results as Array<Record<string, unknown>>) {
    if (!r || !num(r.latitude) || !num(r.longitude)) continue;
    const country = str(r.country);
    const region = str(r.admin1);
    if (hint && !`${country} ${region} ${str(r.country_code)}`.toLowerCase().includes(hint)) continue;
    return {
      place: [str(r.name), country].filter(Boolean).join(", "),
      latitude: r.latitude,
      longitude: r.longitude,
    };
  }
  return null;
}

export interface CurrentWeather {
  kind: WeatherKind;
  temperatureC: number;
}

/** The `current` block of a forecast answer; null when it is missing a field. */
export function parseCurrent(json: unknown): CurrentWeather | null {
  const cur = (json as { current?: Record<string, unknown> } | null)?.current;
  if (!cur || !num(cur.weather_code) || !num(cur.temperature_2m)) return null;
  return {
    kind: weatherKind(cur.weather_code, cur.is_day !== 0),
    temperatureC: cur.temperature_2m,
  };
}

/** "Kyiv, Ukraine · 4°C, Rain" */
export function describeWeather(place: string, kind: WeatherKind, temperatureC: number): string {
  return `${place} · ${Math.round(temperatureC)}°C, ${WEATHER_LABEL[kind]}`;
}
