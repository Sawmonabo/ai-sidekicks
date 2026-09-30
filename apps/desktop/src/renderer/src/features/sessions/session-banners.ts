// The session screen's banner column: what it says, what it coalesces, and what it keeps.
//
// A banner sits directly under the session header in the header's banner shape and
// speaks in plain words; the code of the failure behind it goes to the window's
// diagnostic capture, never onto the screen. Two properties are this column's own,
// because neither is a property of one banner:
//
//   • **A REPEATED BANNER IS ONE BANNER.** A failing store refuses a save on every
//     pane the person moves, so a drag produced a column of identical banners all
//     saying one thing. A repeat leaves the standing banner as it is, and draws no count.
//   • **AND THE WORDS ARE THE IDENTITY, WHICH IS WHY THE RENDER KEYS ON THEM.** A list
//     keyed by array position renumbers every banner below a dismissed one: React
//     unmounts and remounts banners that had not changed, which takes focus off the
//     dismiss control somebody was tabbing through.
//
// NOTHING IS DROPPED. There is no cap here and no eviction: coalescing bounds the
// repeat, and every banner left says a different thing.

/** One banner on screen: its words, in the order they read, parted by ` · ` when drawn. */
export interface SessionBanner {
  readonly words: readonly string[];
}

/**
 * The banner a failed save of the pane layout raises. The arrangement stays on screen
 * and is saved again on the next change.
 */
export const PANE_LAYOUT_NOT_SAVED_BANNER: SessionBanner = Object.freeze({
  words: Object.freeze(["Pane layout not saved", "it will save again on your next change"]),
});

/**
 * A column with nothing on it, as one value.
 *
 * One frozen array rather than a fresh one per reading, so a holder seeded with it and
 * a dismissal that emptied the column answer the same identity — a subscriber comparing
 * by reference is told nothing changed when nothing did.
 */
export const NO_SESSION_BANNERS: readonly SessionBanner[] = Object.freeze([]);

/**
 * The identity of a banner as this column counts it.
 *
 * Joined on a NUL rather than on a separator the words could contain: with a printable
 * joiner, two banners whose words split at different places would compose the same
 * string and coalesce into one.
 */
export function sessionBannerKey(banner: SessionBanner): string {
  return banner.words.join("\u0000");
}

/**
 * Raise one. A banner already saying the same words stands as it is, in its place, so
 * the column a person is reading does not move under them.
 */
export function raiseSessionBanner(
  current: readonly SessionBanner[],
  banner: SessionBanner,
): readonly SessionBanner[] {
  const key = sessionBannerKey(banner);
  if (current.some((standing) => sessionBannerKey(standing) === key)) {
    return current;
  }
  return [...current, banner];
}

/** Put one away, by the identity the render keyed it on. */
export function dismissSessionBanner(
  current: readonly SessionBanner[],
  key: string,
): readonly SessionBanner[] {
  return current.filter((banner) => sessionBannerKey(banner) !== key);
}
