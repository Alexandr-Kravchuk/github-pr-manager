// The one-time "Try a new look" card (Settings › Appearance › Style, offered
// in place). It is for people who updated into the styles, so a fresh install
// never sees it, and once closed it never comes back.
//
// Pure, so the rule is unit-tested without Electron; main/settings.ts keeps
// the record in userData/style-offer.json — not in settings.json (whose
// unknown-field rules a one-off flag has no business with) and not in
// whats-new.json, which is rewritten whole on every version.

export interface StyleOfferRecord {
  /** The card was closed, or this is a fresh install: never show it again. */
  done: true;
}

/** Reads a stored record; anything malformed counts as no record. */
export function parseStyleOfferRecord(json: unknown): StyleOfferRecord | null {
  const r = json as Partial<StyleOfferRecord> | null;
  return r && r.done === true ? { done: true } : null;
}

/**
 * Decided once per start, before the "What's new" record is seeded: with no
 * record of that either, this is a fresh install — nothing was updated, so the
 * offer is settled as done. An earlier install (a "What's new" record) with no
 * offer record yet gets the card.
 */
export function styleOfferAtStart(
  record: StyleOfferRecord | null,
  hasWhatsNewRecord: boolean,
): { offer: boolean; write: StyleOfferRecord | null } {
  if (record) return { offer: false, write: null };
  if (!hasWhatsNewRecord) return { offer: false, write: { done: true } };
  return { offer: true, write: null };
}
