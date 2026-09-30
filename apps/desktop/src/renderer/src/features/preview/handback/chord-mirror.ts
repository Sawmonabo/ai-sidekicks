// The key a chord mirror is compared by, and the register of what the page host holds.
// The key joins chords on a space, lossless because `chord-claim.ts` refuses spaced sequences.
// "Nothing published" is a state, not an empty value: unbinding the last claimable chord owes the
// host an empty publication, or the old mirror stays installed.

/** What a mirror key joins on; no chord contains it, because sequences never reach a mirror. */
const MIRROR_CHORD_SEPARATOR = " ";

/** The key of a mirror holding no chord, and of a host that has been told nothing. */
const EMPTY_CHORD_MIRROR_KEY = "";

/**
 * What one pane's page host is currently holding, so a publication can be owed. Minted per
 * subject: a pane rebound to another window addresses a host that has been told nothing.
 *
 * Recorded at dispatch, not settlement: a failed publish leaves nothing to clear, while a
 * lost reply may have landed, and skipping that clear would leave the mirror installed.
 *
 * @consumedBy the preview pane's handback, which tells the host the chords the page claims
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
 * One projection as a single value an effect can be keyed on. An unreadable registry and an
 * empty projection share a key on purpose: the page is owed the same "claims nothing" for both.
 *
 * @consumedBy the preview pane's handback, which tells the host the chords the page claims
 */
export function composeChordMirrorKey(mirrorChords: readonly string[] | undefined): string {
  return mirrorChords === undefined
    ? EMPTY_CHORD_MIRROR_KEY
    : mirrorChords.join(MIRROR_CHORD_SEPARATOR);
}

/**
 * The chords a key carries, as the wire takes them. Empty key, empty list.
 *
 * @consumedBy the preview pane's handback, which tells the host the chords the page claims
 */
export function readChordMirrorKey(mirrorKey: string): readonly string[] {
  return mirrorKey === EMPTY_CHORD_MIRROR_KEY ? [] : mirrorKey.split(MIRROR_CHORD_SEPARATOR);
}
