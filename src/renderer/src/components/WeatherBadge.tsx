// The header's weather: one small icon and the temperature next to the PR
// count, the place and the conditions in its tooltip. Nothing at all while
// neither a city (Settings) nor an allowed location is set, or while the
// weather could not be loaded — Settings shows why. Static: no animation.

import type { ReactNode } from "react";

import type { WeatherKind, WeatherStatus } from "../../../shared/types";
import { describeWeather } from "../../../shared/weather";

const CLOUD_TOP = "M4 14.9A7 7 0 1 1 15.7 8h1.8a4.5 4.5 0 0 1 2.5 8.24";

const ICON: Record<WeatherKind, { cls: string; paths: ReactNode }> = {
  "clear-day": {
    cls: "text-amber-500",
    paths: (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
      </>
    ),
  },
  "clear-night": {
    cls: "text-indigo-400 dark:text-indigo-300",
    paths: <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />,
  },
  clouds: {
    cls: "text-fg-muted",
    paths: <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />,
  },
  fog: {
    cls: "text-fg-muted",
    paths: <path d={`${CLOUD_TOP}M16 17H7M17 21H9`} />,
  },
  rain: {
    cls: "text-sky-500",
    paths: <path d={`${CLOUD_TOP}M16 14v6M8 14v6M12 16v6`} />,
  },
  snow: {
    cls: "text-sky-400 dark:text-sky-300",
    paths: <path d={`${CLOUD_TOP}M8 15h.01M8 19h.01M12 17h.01M12 21h.01M16 15h.01M16 19h.01`} />,
  },
  thunder: {
    cls: "text-amber-500",
    paths: <path d="M6 16.33A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 .5 8.97M13 12l-3 5h4l-3 5" />,
  },
};

export function WeatherBadge({ weather }: { weather: WeatherStatus | null }) {
  if (weather?.state !== "ok") return null;
  const icon = ICON[weather.kind];
  const label = describeWeather(weather.place, weather.kind, weather.temperatureC);
  return (
    // align-[-0.3em]: an inline-flex box sits on its bottom edge (the icon has
    // no baseline), so this drops its centre onto the count's capitals.
    <span className="ml-5 inline-flex items-center gap-1 align-[-0.3em] leading-none" title={label} aria-label={label} role="img">
      <svg
        viewBox="0 0 24 24"
        width={16}
        height={16}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        className={icon.cls}
      >
        {icon.paths}
      </svg>
      <span aria-hidden>{Math.round(weather.temperatureC)}°</span>
    </span>
  );
}
