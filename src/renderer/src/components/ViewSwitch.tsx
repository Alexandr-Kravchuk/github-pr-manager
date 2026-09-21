import { cn } from "../format";
import { VIEW_MODES, VIEW_MODE_TITLES, type ViewMode } from "../../../shared/view-mode";

/**
 * The display-variant switch, shaped like Finder's view switch: one segmented
 * control of icon-only buttons in a recessed track, the active one lifted onto a
 * light "pressed" surface. It sits in the header's middle gap — the space
 * between the title block and the Refresh / Settings buttons — which is why it
 * is icons rather than labels: three words there would push Refresh off the row
 * on a narrow window.
 *
 * Icon-only means the tooltip and `aria-label` carry the whole meaning, so they
 * come from `VIEW_MODE_TITLES` ("Cozy — sortable table"), not from the mode name
 * alone.
 */
export function ViewSwitch({
  value,
  onChange,
}: {
  value: ViewMode;
  onChange: (mode: ViewMode) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Display variant"
      className="inline-flex items-center gap-0.5 rounded-lg border border-line-strong bg-elevated p-0.5"
    >
      {VIEW_MODES.map((mode) => {
        const active = value === mode;
        return (
          <button
            key={mode}
            type="button"
            onClick={() => onChange(mode)}
            title={VIEW_MODE_TITLES[mode]}
            aria-label={VIEW_MODE_TITLES[mode]}
            aria-pressed={active}
            className={cn(
              "inline-flex items-center justify-center rounded-md px-2.5 py-1 transition-colors",
              active
                ? "bg-surface text-fg shadow-sm"
                : "text-fg-muted hover:bg-surface/60 hover:text-fg-secondary",
            )}
          >
            <ViewModeIcon mode={mode} />
          </button>
        );
      })}
    </div>
  );
}

function ViewModeIcon({ mode }: { mode: ViewMode }) {
  switch (mode) {
    case "roomy":
      return <RoomyIcon />;
    case "cozy":
      return <CozyIcon />;
    case "compact":
      return <CompactIcon />;
  }
}

/** Four big tiles — Finder's icon view, and the full cards here. */
function RoomyIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden>
      <rect x="3" y="3" width="8" height="8" rx="1.8" />
      <rect x="13" y="3" width="8" height="8" rx="1.8" />
      <rect x="3" y="13" width="8" height="8" rx="1.8" />
      <rect x="13" y="13" width="8" height="8" rx="1.8" />
    </svg>
  );
}

/** Rows with a leading marker — Finder's list view, and the table here. */
function CozyIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden>
      <circle cx="4.5" cy="6" r="1.6" />
      <rect x="8.5" y="5" width="12.5" height="2" rx="1" />
      <circle cx="4.5" cy="12" r="1.6" />
      <rect x="8.5" y="11" width="12.5" height="2" rx="1" />
      <circle cx="4.5" cy="18" r="1.6" />
      <rect x="8.5" y="17" width="12.5" height="2" rx="1" />
    </svg>
  );
}

/** Nine small tiles — the same layout as Roomy, denser. */
function CompactIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden>
      {[3.5, 10, 16.5].map((y) =>
        [3.5, 10, 16.5].map((x) => (
          <rect key={`${x}-${y}`} x={x} y={y} width="4" height="4" rx="1" />
        )),
      )}
    </svg>
  );
}
