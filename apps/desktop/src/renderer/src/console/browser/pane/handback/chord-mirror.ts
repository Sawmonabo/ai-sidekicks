// How a chord mirror is spelled for one comparison, and what the host has been told.
//
// `Spec-023 §Console Design (Meridian)` 12.4's mirror is published and never polled,
// so the binding beside this file re-publishes exactly when the projected set changes.
// "Changes" is the whole question, and the two halves of answering it live here
// together because they are one seam: the KEY a projection is compared by, and the
// register saying which key the host is currently holding.
//
// THE KEY AND THE CHORDS ARE ENCODED AND DECODED IN ONE MODULE, on this package's
// rule about two sides of one seam. The key is the chord list joined on a space, which
// is lossless because a space is tinykeys' SEQUENCE separator and `chord-claim.ts`
// refuses a sequence before it can reach a mirror — so no chord in a projection ever
// contains one. Splitting a key back was written at the publish site once and got the
// empty case wrong: `"".split(" ")` is a one-member list holding an empty string, so a
// mirror holding no chord would have travelled as a mirror holding one unparseable
// one.
//
// AND "NOTHING PUBLISHED" IS A STATE, NOT AN EMPTY VALUE. A truthiness check on the
// key cannot tell a pane whose window never had a claimable chord from one whose
// operator has just unbound the last of them. The first owes the host nothing — a host
// that was told nothing claims nothing. The second owes it an EMPTY publication, and
// skipping it leaves the old mirror installed in the page host: the host goes on
// claiming chords the renderer's own projection no longer holds, so it takes each of
// those keystrokes from the page and hands back a chord the replay declines. The
// keystroke reaches neither surface. The register below is what separates the two, by
// remembering the last key published INCLUDING the empty one.

/**
 * What a mirror key joins on, and what a chord may therefore never contain.
 *
 * tinykeys spells a multi-press binding with a space, and a sequence is refused by
 * `chordCarriesApplicationModifier` before it can reach a mirror — so this separator
 * is unambiguous by the projection's own rule rather than by convention.
 */
const MIRROR_CHORD_SEPARATOR = " ";

/** The key of a mirror holding no chord, and of a host that has been told nothing. */
const EMPTY_CHORD_MIRROR_KEY = "";

/**
 * What one pane's page host is currently holding, so a publication can be owed.
 *
 * A class with a private field because the whole point is that the field is written
 * in exactly one place — the moment a publication is dispatched — and read in exactly
 * one other. It is minted per SUBJECT by its caller: a pane rebound to another window
 * is addressing a host that has been told nothing, and a register carried across that
 * rebind would decide the new host already holds a mirror it has never seen.
 *
 * A publication is recorded at DISPATCH and not at settlement, which is the safe
 * direction on both arms: a publication that failed leaves the host holding nothing,
 * so a later clear is a no-op, while a publication whose reply was lost may well have
 * landed — and a clear the register decided to skip would leave that mirror installed
 * forever.
 */
export class ChordMirrorPublication {
  /** Empty rather than absent: a host nobody has published to claims no chord. */
  #publishedChordKey: string = EMPTY_CHORD_MIRROR_KEY;

  /** Whether this projection differs from what the host is known to be holding. */
  public needsPublication(mirrorKey: string): boolean {
    return mirrorKey !== this.#publishedChordKey;
  }

  /** Record the projection just dispatched, the empty one included. */
  public recordPublication(mirrorKey: string): void {
    this.#publishedChordKey = mirrorKey;
  }
}

/**
 * One projection as a single value an effect can be keyed on.
 *
 * An unreadable registry and an empty projection compose to the same key, and that is
 * correct rather than a conflation: 12.4's fourth rule sends both to the page, so both
 * are "this pane claims nothing" and the host is owed the same sentence for either.
 */
export function composeChordMirrorKey(mirrorChords: readonly string[] | undefined): string {
  return mirrorChords === undefined
    ? EMPTY_CHORD_MIRROR_KEY
    : mirrorChords.join(MIRROR_CHORD_SEPARATOR);
}

/** The chords a key carries, as the wire takes them. Empty key, empty list. */
export function readChordMirrorKey(mirrorKey: string): readonly string[] {
  return mirrorKey === EMPTY_CHORD_MIRROR_KEY ? [] : mirrorKey.split(MIRROR_CHORD_SEPARATOR);
}
