// The session screen's banner column: what it says, what it coalesces, and what it keeps.
//
// A banner sits under the session header and speaks in plain words; the failure's code goes to
// the window's diagnostic capture, not the screen.
//   - A repeated banner is one banner: a failing store refuses a save on every pane moved, and a
//     repeat leaves the standing banner as it is, with no count.
//   - The words are the identity, and the render keys on them: keying by position would renumber
//     banners below a dismissed one and pull focus off the dismiss control.
// Nothing is dropped; coalescing bounds the repeats and there is no cap.

import { structuralKey } from "#renderer/lib/structural-key.js";

/** One banner on screen: its words, in the order they read, parted by ` · ` when drawn. */
export interface SessionBanner {
  readonly words: readonly string[];
}

/**
 * The banner a failed save of the pane layout raises. The arrangement stays on screen
 * and is saved again on the next change.
 */
export const PANE_LAYOUT_NOT_SAVED_BANNER: SessionBanner = Object.freeze({
  words: Object.freeze(["Pane layout not saved", "it will save again on the next change"]),
});

/** An empty column as one shared value, so a subscriber comparing by reference sees no change. */
export const NO_SESSION_BANNERS: readonly SessionBanner[] = Object.freeze([]);

/**
 * The identity of a banner as this column counts it, so two banners whose words split at
 * different places cannot compose the same key and coalesce.
 */
export function sessionBannerKey(banner: SessionBanner): string {
  return structuralKey(banner.words);
}

/**
 * Raises a banner. One already saying the same words stands as it is, in place, so the column
 * does not move under a reader.
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

/** Puts one banner away, by the identity the render keys on. */
export function dismissSessionBanner(
  current: readonly SessionBanner[],
  key: string,
): readonly SessionBanner[] {
  return current.filter((banner) => sessionBannerKey(banner) !== key);
}
