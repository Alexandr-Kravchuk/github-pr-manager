import { useCallback, useEffect, useRef, useState } from "react";

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
  const previousMood = useRef(mood);
  const [animation, setAnimation] = useState<{ mood: BuddyMood; run: number } | null>(null);

  const animate = useCallback(() => {
    setAnimation((current) => ({ mood, run: (current?.run ?? 0) + 1 }));
  }, [mood]);

  // A mood change is the status event worth drawing attention to. Keeping the
  // mood alongside the run counter prevents the previous mood's animation from
  // briefly starting before this effect schedules the new one.
  useEffect(() => {
    if (previousMood.current !== mood) {
      previousMood.current = mood;
      animate();
    }
  }, [animate, mood]);

  const isAnimating = animation?.mood === mood;
  const animationRun = animation?.run ?? 0;
  const bodyAnimation = isAnimating
    ? mood === "sleeping"
      ? "buddy-breathe"
      : mood === "sad"
        ? "buddy-droop"
        : "buddy-bob"
    : undefined;

  return (
    <svg
      viewBox="0 0 48 44"
      width={44}
      height={40}
      role="button"
      tabIndex={0}
      aria-label={meta.label}
      onClick={animate}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          animate();
        }
      }}
      className={`buddy shrink-0 cursor-pointer rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current ${meta.cls}`}
    >
      <title>{meta.label}</title>

      <g key={`body-${animationRun}`} className={bodyAnimation}>
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
              className={isAnimating ? "buddy-tear" : undefined}
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
            <circle className={isAnimating ? "buddy-look" : undefined} cx="18.5" cy="25.5" r="1.5" fill="currentColor" stroke="none" />
            <circle className={isAnimating ? "buddy-look" : undefined} cx="29.5" cy="25.5" r="1.5" fill="currentColor" stroke="none" />
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
        <g key={`zzz-${animationRun}`} fill="currentColor" fontFamily="inherit" fontWeight="600">
          <text className={isAnimating ? "buddy-zzz" : undefined} x="33" y="15" fontSize="9">z</text>
          <text className={isAnimating ? "buddy-zzz buddy-zzz-2" : undefined} x="38" y="10" fontSize="7">z</text>
          <text className={isAnimating ? "buddy-zzz buddy-zzz-3" : undefined} x="43" y="6" fontSize="5">z</text>
        </g>
      )}
    </svg>
  );
}
