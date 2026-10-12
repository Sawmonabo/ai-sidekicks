// One lane's text: the source, held once as packed UTF-8, and a cursor that says how much of it is
// revealed. Revealing moves the cursor and copies nothing, an append encodes only what it brings,
// and a reader reads the revealed prefix through this rope as a `PublishedText` instead of through
// a growing string. `append` is the single text writer; `advance`, `releasePending` and `rebase`
// are the only cursor writers.

import { PackedText } from "#renderer/lib/text/packed.js";
import { type PublishedText } from "#renderer/lib/text/published.js";

/**
 * One lane's text and a cursor that only a rebase moves back. The rope is also the lane's
 * `PublishedText`: its reads see the revealed prefix alone, and it is the same object for the
 * lane's whole life, rebases included.
 */
export class RevealTextRope implements PublishedText {
  readonly #laneId: string;
  /** The source, revealed or not: the rope's own copy, which no reader is handed. */
  readonly #source = new PackedText();
  /** The rewrites that cut revealed text, newest last: what `keepsPrefix` answers from. */
  readonly #retractions: Retraction[] = [];

  #revealedLength = 0;
  #revision = 0;
  /** The newest retraction dropped from the log; a reader older than it cannot be answered. */
  #forgottenRetractionRevision = NO_REVISION;

  public constructor(laneId: string) {
    this.#laneId = laneId;
  }

  /**
   * The single text writer. Encodes `text` onto the source, so the rope keeps nothing of a larger
   * string it was cut from (an authoritative commit's whole source). An empty append changes
   * nothing.
   */
  public append(text: string): void {
    this.#source.append(text);
  }

  /**
   * Move the cursor forward by at most `characterBudget` and return how far it went. Never
   * backwards. The code-point boundary is enforced here, where the budget is spent.
   */
  public advance(characterBudget: number): number {
    const budget = this.#snappedToCodePointBoundary(
      Math.max(0, Math.min(characterBudget, this.pendingCharacterCount)),
    );
    if (budget > 0) {
      this.#revealedLength += budget;
      this.#revision += 1;
    }
    return budget;
  }

  /**
   * Drop the text past the cursor, keeping what a reader already saw: the lane will reveal no
   * more of it. Afterwards the rope is settled.
   */
  public releasePending(): void {
    this.#truncateSource(this.#revealedLength);
  }

  /**
   * Replace the source with `source`, keeping the first `agreedLength` characters, which it must
   * share with the revealed prefix, and revealing exactly those. A cursor left between the halves
   * of a surrogate pair takes the trailing half too, as a reveal from the start would.
   */
  public rebase(source: string, agreedLength: number): void {
    const revealedBefore = this.#revealedLength;
    this.#truncateSource(agreedLength);
    this.append(source.slice(agreedLength));
    this.#revealedLength += this.#snappedToCodePointBoundary(0, true);
    if (agreedLength < revealedBefore) {
      this.#recordRetraction(agreedLength);
    } else if (this.#revealedLength !== revealedBefore) {
      this.#revision += 1;
    }
  }

  /**
   * The last `characterCount` characters of the revealed prefix, so the gate gets context behind
   * the cursor without reading the whole prefix each frame.
   */
  public revealedTail(characterCount: number): string {
    return this.#source.slice(
      Math.max(0, this.#revealedLength - characterCount),
      this.#revealedLength,
    );
  }

  /**
   * Up to `characterCount` characters past the cursor, for the gate to decide whether the
   * cursor stands on a construct. Bounded by the caller rather than materializing the source.
   */
  public lookahead(characterCount: number): string {
    return this.#source.slice(
      this.#revealedLength,
      this.#revealedLength + Math.max(0, characterCount),
    );
  }

  /** Whether this rope's source is a prefix of `candidate`, compared chunk by chunk. */
  public isPrefixOf(candidate: string): boolean {
    if (candidate.length < this.#source.length) {
      return false;
    }
    let start = 0;
    for (const chunk of this.#source.chunks()) {
      if (!candidate.startsWith(chunk, start)) {
        return false;
      }
      start += chunk.length;
    }
    return true;
  }

  /** How many leading characters the revealed prefix shares with `candidate`. */
  public commonRevealedPrefixLength(candidate: string): number {
    const ceiling = Math.min(this.#revealedLength, candidate.length);
    let start = 0;
    for (const chunk of this.chunks()) {
      const piece = chunk.slice(0, ceiling - start);
      if (!candidate.startsWith(piece, start)) {
        let shared = start;
        while (piece[shared - start] === candidate[shared]) {
          shared += 1;
        }
        return shared;
      }
      start += piece.length;
      if (start >= ceiling) {
        break;
      }
    }
    return ceiling;
  }

  public get laneId(): string {
    return this.#laneId;
  }

  public get sourceLength(): number {
    return this.#source.length;
  }

  /** The revealed prefix's length: what a reader of this rope sees. */
  public get length(): number {
    return this.#revealedLength;
  }

  public get revision(): number {
    return this.#revision;
  }

  /** Whether the revealed prefix holds an escape. */
  public get holdsEscape(): boolean {
    const escapeIndex = this.#source.firstEscapeIndex;
    return escapeIndex !== -1 && escapeIndex < this.#revealedLength;
  }

  public get pendingCharacterCount(): number {
    return this.#source.length - this.#revealedLength;
  }

  public get isSettled(): boolean {
    return this.pendingCharacterCount === 0;
  }

  public slice(start: number, end: number = this.#revealedLength): string {
    return this.#source.slice(
      clampedTo(start, this.#revealedLength),
      clampedTo(end, this.#revealedLength),
    );
  }

  public indexOf(character: string, from: number): number {
    const found = from >= this.#revealedLength ? -1 : this.#source.indexOf(character, from);
    return found < this.#revealedLength ? found : -1;
  }

  public *chunks(): Generator<string> {
    let start = 0;
    for (const chunk of this.#source.chunks()) {
      if (start >= this.#revealedLength) {
        return;
      }
      yield start + chunk.length <= this.#revealedLength
        ? chunk
        : chunk.slice(0, this.#revealedLength - start);
      start += chunk.length;
    }
  }

  public keepsPrefix(revision: number, length: number): boolean {
    if (length > this.#revealedLength || revision < this.#forgottenRetractionRevision) {
      return false;
    }
    return this.#retractions.every(
      (retraction) => retraction.revision <= revision || retraction.revealedLength >= length,
    );
  }

  /**
   * `budget`, extended by one code unit if spending it would stop between the halves of a
   * surrogate pair; otherwise the gate would judge a lone leading surrogate literal-safe and
   * publish it for a frame. Extends and never retreats, so a one-character share cannot spin
   * the frame loop. A budget reaching the end of the source is spent as-is, so a pair split
   * across what the producer has sent so far publishes as it arrived and heals on the next
   * append. Grapheme clusters are not snapped: their completeness is undecidable at the end of
   * an in-flight source, and a partial cluster renders as valid glyphs. `atCursor` judges a stop
   * at the cursor itself, which only a rebase leaves where a reveal did not put it.
   */
  #snappedToCodePointBoundary(budget: number, atCursor = false): number {
    if ((budget === 0 && !atCursor) || budget >= this.pendingCharacterCount) {
      return budget;
    }
    const stop = this.#revealedLength + budget;
    if (stop === 0) {
      return budget;
    }
    const around = this.#source.slice(stop - 1, stop + 1);
    return LEADING_SURROGATE.test(around.charAt(0)) && TRAILING_SURROGATE.test(around.charAt(1))
      ? budget + 1
      : budget;
  }

  /** Cut the source to `length` characters. The cursor never stays past the source. */
  #truncateSource(length: number): void {
    this.#source.truncate(length);
    this.#revealedLength = Math.min(this.#revealedLength, this.#source.length);
  }

  /** Note a rewrite that cut revealed text back to `revealedLength`, under a new revision. */
  #recordRetraction(revealedLength: number): void {
    this.#revision += 1;
    this.#retractions.push({ revision: this.#revision, revealedLength });
    if (this.#retractions.length > RETRACTION_LOG_CAP) {
      this.#forgottenRetractionRevision = this.#retractions.shift()?.revision ?? NO_REVISION;
    }
  }
}

/** One rewrite that cut revealed text, and how much it kept. */
interface Retraction {
  readonly revision: number;
  readonly revealedLength: number;
}

/**
 * The most rewrites `keepsPrefix` remembers. A rewrite is a producer's retry or rollback, a few
 * in a turn; a reader that has not looked since an older one is told no and rescans.
 */
const RETRACTION_LOG_CAP = 8;

/** Below every revision a rope reports. */
const NO_REVISION = -1;

/**
 * The first half of a UTF-16 surrogate pair, on its own. Under the `u` flag a well-formed pair
 * is one code point outside both ranges, so these match only a lone unit.
 */
const LEADING_SURROGATE = /^[\uD800-\uDBFF]$/u;

/** The second half of a UTF-16 surrogate pair, on its own. */
const TRAILING_SURROGATE = /^[\uDC00-\uDFFF]$/u;

function clampedTo(offset: number, length: number): number {
  return Math.min(length, Math.max(0, offset));
}
