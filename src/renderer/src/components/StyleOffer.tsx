import { UI_STYLES } from "../../../shared/ui-style";
import type { UiStyle } from "../../../shared/types";
import { cn } from "../format";

/** One line on each look, so a name like "Bento grid" says what it does. */
const STYLE_HINT: Record<UiStyle, string> = {
  flat: "The default: clean, flat cards",
  neumorphism: "Cards raised out of the background by soft light and shadow",
  claymorphism: "Soft, rounded, pastel — like clay",
  neobrutalism: "Thick outlines, hard shadows, loud colours",
  bento: "Borderless cells, some twice as wide",
  glassmorphism: "Frosted glass over a slowly drifting colourful backdrop",
  terminal: "A monospace console: square frames, phosphor accent",
  paper: "Calm and editorial: warm paper, ink lines, a serif",
  creatio: "Creatio's own look: its colours and Montserrat",
};

/**
 * The one-time "Try a new look" card after an update. Each style button
 * applies the look at once — the dashboard behind the card is the preview —
 * and the card stays open so the next one can be tried. Closing it (× or
 * "Keep this one") ends the offer for good; Settings › Appearance has the
 * same choice later.
 */
export function StyleOffer({
  current,
  onPick,
  onClose,
}: {
  current: UiStyle;
  onPick: (style: UiStyle) => void;
  onClose: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-labelledby="style-offer-title"
      className="fixed bottom-10 left-4 z-30 w-[22rem] max-w-[calc(100vw-2rem)] rounded-xl border border-line bg-surface p-4 text-sm shadow-xl"
    >
      <div className="mb-1 flex items-start justify-between gap-2">
        <h2 id="style-offer-title" className="font-semibold text-fg">
          ✨ Try a new look
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close — don't offer this again"
          title="Close — don't offer this again"
          className="-mr-1 -mt-1 rounded px-1.5 text-lg leading-none text-fg-subtle hover:text-fg"
        >
          ×
        </button>
      </div>
      <p className="mb-3 text-xs text-fg-muted">
        PR Dashboard now comes in {UI_STYLES.length} styles. Pick one and see it right away — you can switch any time in
        Settings › Appearance.
      </p>
      <div className="grid grid-cols-2 gap-1.5">
        {UI_STYLES.map((s) => (
          <button
            key={s.value}
            type="button"
            aria-pressed={current === s.value}
            title={STYLE_HINT[s.value]}
            onClick={() => onPick(s.value)}
            className={cn(
              "rounded-md border px-2 py-1.5 text-left text-xs font-medium transition-colors",
              current === s.value
                ? "border-sky-500 bg-sky-500/15 text-sky-700 dark:text-sky-300"
                : "border-line-strong bg-elevated text-fg-secondary hover:bg-elevated hover:text-fg",
            )}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-sky-600 bg-sky-600 px-3 py-1 text-xs font-medium text-white hover:bg-sky-700 dark:border-sky-500 dark:bg-sky-500/90"
        >
          Keep this one
        </button>
      </div>
    </div>
  );
}
