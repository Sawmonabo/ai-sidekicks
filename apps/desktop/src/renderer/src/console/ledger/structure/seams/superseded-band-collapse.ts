// Which superseded bands one reader has folded away.
//
// THE DEFAULT IS OPEN, AND THAT IS THE WHOLE DESIGN. `superseded-bands.ts` states the
// rule this state serves: a rewound band "stays present but visibly past", and the
// ledger "dims a band rather than deleting one, so a person can still read what was
// rewound away". A fold that started shut would delete the band from the screen by
// default and make the dimming unreachable — so this holds the FOLDED keys, starts
// empty, and every band is on screen and dimmed until somebody asks otherwise.
//
// WHY A CLASS RATHER THAN A SET IN A HOOK. The same reason `ChapterCollapseState` is
// one: the rule about what "folded" means belongs beside the state that answers it,
// and a bare set in a render body would put the default in every caller.

import { supersededBandKey, type SupersededBand } from "./superseded-bands.js";

/**
 * One reader's folded bands.
 *
 * The state is per SESSION rather than per mount — the shell opens session stores and
 * never closes them, so a pane that follows a navigation would otherwise carry one
 * session's folds into the next one's rows.
 */
export class SupersededBandCollapseState {
  readonly #foldedBandKeys = new Set<string>();

  /** The bands this reader folded. Every other band is on screen and dimmed. */
  public get foldedBandKeys(): ReadonlySet<string> {
    return this.#foldedBandKeys;
  }

  /** Whether this band's rows are folded away behind its header. */
  public isFolded(band: SupersededBand): boolean {
    return this.#foldedBandKeys.has(supersededBandKey(band));
  }

  /** Fold an open band, or open a folded one. */
  public toggle(band: SupersededBand): void {
    const key = supersededBandKey(band);
    if (this.#foldedBandKeys.has(key)) {
      this.#foldedBandKeys.delete(key);
      return;
    }
    this.#foldedBandKeys.add(key);
  }

  /**
   * Open the band holding this key, and answer whether anything moved.
   *
   * What a jump into a folded band calls. It OPENS and never toggles: the caller is
   * reaching a row it could not otherwise scroll to, and a toggle there would fold a
   * band that was already open and scroll to a row that had just left the viewport.
   */
  public openBandKey(bandKey: string): boolean {
    return this.#foldedBandKeys.delete(bandKey);
  }
}
