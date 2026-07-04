export type BuddyMood = "sad" | "curious" | "sleeping";

const MOOD_META: Record<BuddyMood, { cls: string; label: string }> = {
  sad: {
    cls: "text-red-500 dark:text-red-400",
    label: "Some of your PRs are red — CI failing or reviewers waiting on you",
  },
  curious: {
    cls: "text-violet-500 dark:text-violet-400",
    label: "PRs are waiting for your review",
  },
  sleeping: {
    cls: "text-emerald-500 dark:text-emerald-400",
    label: "All quiet — nothing needs you right now",
  },
};

/**
 * Little animated status buddy for the header. Mirrors the dashboard's card
 * accents: sad when any of your PRs is red (blocked on you), curious when a
 * review is requested of you, asleep when everything is gray/amber.
 */
export function Buddy({ mood }: { mood: BuddyMood }) {
  const meta = MOOD_META[mood];
  return (
    <svg
      viewBox="0 0 48 44"
      width={44}
      height={40}
      role="img"
      aria-label={meta.label}
      className={`buddy shrink-0 ${meta.cls}`}
    >
      <title>{meta.label}</title>

      <g className={mood === "sleeping" ? "buddy-breathe" : mood === "sad" ? "buddy-droop" : "buddy-bob"}>
        {/* Body */}
        <circle cx="24" cy="26" r="15" fill="currentColor" opacity="0.14" />
        <circle cx="24" cy="26" r="15" fill="none" stroke="currentColor" strokeWidth="1.6" opacity="0.75" />

        {mood === "sad" && (
          <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none">
            {/* Sad brows — inner ends raised */}
            <path d="M14.5 22.5 L20 20.5" />
            <path d="M33.5 22.5 L28 20.5" />
            {/* Droopy eyes */}
            <circle cx="18.5" cy="26" r="1.7" fill="currentColor" stroke="none" />
            <circle cx="29.5" cy="26" r="1.7" fill="currentColor" stroke="none" />
            {/* Frown */}
            <path d="M19 34 Q24 30.5 29 34" />
            {/* Tear */}
            <path
              className="buddy-tear"
              d="M32.5 28.5 q1.4 2 0 3 q-1.4 -1 0 -3"
              fill="#38bdf8"
              stroke="none"
            />
          </g>
        )}

        {mood === "curious" && (
          <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none">
            {/* Raised brows, one higher — intrigued */}
            <path d="M15 19 Q18.5 17 22 19" />
            <path d="M27 16.5 Q30.5 14.5 34 16.5" />
            {/* Wide eyes with wandering pupils */}
            <circle cx="18.5" cy="25.5" r="3.4" />
            <circle cx="29.5" cy="25.5" r="3.4" />
            <circle className="buddy-look" cx="18.5" cy="25.5" r="1.5" fill="currentColor" stroke="none" />
            <circle className="buddy-look" cx="29.5" cy="25.5" r="1.5" fill="currentColor" stroke="none" />
            {/* Small "o" mouth */}
            <circle cx="24" cy="33.5" r="1.8" />
          </g>
        )}

        {mood === "sleeping" && (
          <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none">
            {/* Closed eyes */}
            <path d="M15.5 26 Q18.5 28.5 21.5 26" />
            <path d="M26.5 26 Q29.5 28.5 32.5 26" />
            {/* Relaxed mouth */}
            <path d="M22 33 Q24 34 26 33" />
          </g>
        )}
      </g>

      {mood === "sleeping" && (
        <g fill="currentColor" fontFamily="inherit" fontWeight="600">
          <text className="buddy-zzz" x="33" y="15" fontSize="9">z</text>
          <text className="buddy-zzz buddy-zzz-2" x="38" y="10" fontSize="7">z</text>
          <text className="buddy-zzz buddy-zzz-3" x="43" y="6" fontSize="5">z</text>
        </g>
      )}
    </svg>
  );
}
