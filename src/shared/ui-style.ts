// The app's looks (Settings › Appearance › Style), in menu order. Node-free so
// the renderer can value-import it (see AGENTS.md): settings validation, the
// IPC check, the Settings menu and the renderer's attribute all read this one
// list, so a new style cannot be half-added.

import type { UiStyle } from "./types";

export const UI_STYLES: ReadonlyArray<{ value: UiStyle; label: string }> = [
  { value: "flat", label: "Flat" },
  { value: "neumorphism", label: "Neumorphism" },
  { value: "claymorphism", label: "Claymorphism" },
  { value: "neobrutalism", label: "Neobrutalism" },
  { value: "bento", label: "Bento grid" },
  { value: "glassmorphism", label: "Glassmorphism" },
];

export function isUiStyle(value: unknown): value is UiStyle {
  return UI_STYLES.some((s) => s.value === value);
}
