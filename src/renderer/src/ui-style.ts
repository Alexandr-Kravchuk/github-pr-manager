// The app's look (Settings › Appearance): one attribute on <html>,
// `data-ui="<style>"` (none for flat), that styles.css
// keys its tokens and rules on. Kept in localStorage as well, so the first
// frame after a restart already has the look instead of flashing the flat one
// until `getConfig` answers; settings.json stays the source of truth.

import type { UiStyle } from "../../shared/types";
import { isUiStyle } from "../../shared/ui-style";
import { resetGlassDrift, syncGlassDrift } from "./glass-drift";

const KEY = "prd:ui-style";

function setAttribute(style: UiStyle): void {
  const root = document.documentElement;
  if (style === "flat") delete root.dataset.ui;
  else root.dataset.ui = style;
  syncGlassDrift();
}

export function applyUiStyle(style: UiStyle): void {
  // Startup applies the remembered look and then the config's, the same one:
  // only a real switch starts the glass backdrop's drift over.
  const before = document.documentElement.dataset.ui ?? "flat";
  setAttribute(style);
  if (style === "glassmorphism" && before !== style) resetGlassDrift();
  try {
    localStorage.setItem(KEY, style);
  } catch {
    /* storage can be unavailable; the attribute is what counts */
  }
}

/** The look the last run had, applied before React renders. */
export function applyRememberedUiStyle(): void {
  try {
    const style = localStorage.getItem(KEY);
    if (isUiStyle(style)) setAttribute(style);
  } catch {
    /* nothing remembered */
  }
}
