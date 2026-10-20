import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Open/close state of a small menu hung under a button and portalled to
 * <body> at a fixed position — the table's cells clip with `overflow-hidden`,
 * so a menu rendered in place would be cut to the cell. It closes on a click
 * outside the button and the menu, on Escape, and on scroll or resize, since a
 * fixed menu would otherwise drift away from its button.
 */
export function useAnchoredMenu<B extends HTMLElement = HTMLButtonElement>(widthPx: number) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const buttonRef = useRef<B>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setAnchor(null), []);
  const toggle = useCallback(
    () => setAnchor((prev) => (prev ? null : (buttonRef.current?.getBoundingClientRect() ?? null))),
    [],
  );

  useEffect(() => {
    if (!anchor) return;
    const onPointer = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [anchor, close]);

  // Kept inside the window: shifted left when it would run off the right edge.
  const style = anchor
    ? {
        position: "fixed" as const,
        top: anchor.bottom + 4,
        left: Math.max(8, Math.min(anchor.left, window.innerWidth - widthPx - 8)),
        width: widthPx,
      }
    : undefined;

  return { open: anchor !== null, toggle, close, buttonRef, menuRef, style };
}
