// When the bottom-right "What's new in vX" button shows. It is lit for the
// first half hour after an update — counted from the first time this version
// was asked about, i.e. its first launch — and then gives way to the plain
// version label, as if the user had clicked it. A click ends it earlier.
//
// Pure, so the rule is unit-tested without Electron; main/settings.ts reads
// and writes the record in userData/whats-new.json.

export const WHATS_NEW_HIGHLIGHT_MS = 30 * 60_000;

export interface WhatsNewRecord {
  /** The last version the user saw the news of (clicked, or let expire). */
  acknowledgedVersion: string;
  /** The version whose news is showing now, and since when (epoch ms). */
  seenVersion?: string;
  seenAt?: number;
}

/** Reads a stored record; anything malformed counts as no record. */
export function parseWhatsNewRecord(json: unknown): WhatsNewRecord | null {
  const r = json as Partial<WhatsNewRecord> | null;
  if (!r || typeof r.acknowledgedVersion !== "string") return null;
  const out: WhatsNewRecord = { acknowledgedVersion: r.acknowledgedVersion };
  if (typeof r.seenVersion === "string" && typeof r.seenAt === "number" && Number.isFinite(r.seenAt)) {
    out.seenVersion = r.seenVersion;
    out.seenAt = r.seenAt;
  }
  return out;
}

/**
 * What to show for `current` at `now`, and the record to keep. `highlightUntil`
 * is null when the plain version label shows. A fresh install (no record) shows
 * no news: there was no update.
 */
export function whatsNewFor(
  record: WhatsNewRecord | null,
  current: string,
  now: number,
): { record: WhatsNewRecord; highlightUntil: number | null } {
  if (!record || record.acknowledgedVersion === current) {
    return { record: { acknowledgedVersion: current }, highlightUntil: null };
  }
  const seenAt = record.seenVersion === current && record.seenAt !== undefined ? record.seenAt : now;
  const highlightUntil = seenAt + WHATS_NEW_HIGHLIGHT_MS;
  if (now >= highlightUntil) return { record: { acknowledgedVersion: current }, highlightUntil: null };
  return { record: { acknowledgedVersion: record.acknowledgedVersion, seenVersion: current, seenAt }, highlightUntil };
}
