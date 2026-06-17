import type { SeenInput, ThemePreference } from "../shared/types";

// Validators for values that cross the IPC boundary from the renderer. The
// renderer is trusted, but a compromised/buggy caller must not be able to push
// arbitrary shapes into the main process, so each handler runs its arguments
// through these before use.

/** Coerces the renderer's mark-seen payload into a clean SeenInput[]. */
export function validateSeenItems(value: unknown): SeenInput[] {
  if (!Array.isArray(value)) {
    throw new Error("mark-seen: expected an array of items.");
  }
  return value
    .filter(
      (it): it is SeenInput =>
        typeof it === "object" &&
        it !== null &&
        typeof (it as SeenInput).id === "string" &&
        typeof (it as SeenInput).comments === "number" &&
        typeof (it as SeenInput).updatedAt === "string",
    )
    .map((it) => ({ id: it.id, comments: it.comments, updatedAt: it.updatedAt }));
}

/** Ensures a URL is a real http(s) URL before handing it to shell.openExternal. */
export function validateExternalUrl(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("openExternal: url must be a string.");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`openExternal: invalid url: ${value}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`openExternal: refusing non-http(s) url: ${value}`);
  }
  return value;
}

/** Ensures a renderer-supplied theme is one of the known preferences. */
export function validateThemePreference(value: unknown): ThemePreference {
  if (value === "system" || value === "light" || value === "dark") {
    return value;
  }
  throw new Error(`setTheme: invalid theme preference: ${String(value)}`);
}

/** Ensures clipboard text is a string of sane length before writing it. */
export function validateClipboardText(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("copyText: expected a string.");
  }
  if (value.length > 10_000) {
    throw new Error("copyText: text too long.");
  }
  return value;
}
