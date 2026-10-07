// The search hit a navigation carries to the page it opens: held when the hit is pressed, and
// taken once by that page, which then moves focus to its heading. Any later arrival on a page, by
// the list, a link or Back, carries none.

import type { SettingsPageId } from "#renderer/routing/settings-page-ids.js";

/** The one search hit waiting for its page, or none. */
export class PendingSearchHit {
  #pageId: SettingsPageId | undefined;

  /** Hold a hit on `pageId`, replacing any hit no page took. */
  public hold(pageId: SettingsPageId): void {
    this.#pageId = pageId;
  }

  /** Whether a hit waits for `pageId`; answering yes gives it up, so a page takes a hit once. */
  public take(pageId: SettingsPageId): boolean {
    if (this.#pageId !== pageId) {
      return false;
    }
    this.#pageId = undefined;
    return true;
  }
}
