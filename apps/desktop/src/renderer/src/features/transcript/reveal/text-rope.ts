// One lane's text: the source as immutable flat chunks, and a cursor that says how much of it is
// revealed. The text is held once: revealing moves the cursor and copies nothing, an append
// rebuilds only the last, partly filled chunk, and a reader reads the revealed prefix through this
// rope as a `PublishedText` instead of through a growing string. `append` is the single text
// writer; `advance`, `releasePending` and `rebase` are the only cursor writers.

import { REVEAL_TEXT_CHUNK_CHARACTERS } from "./caps.js";
import { type PublishedText } from "./published-text.js";

/**
 * One lane's text as chunks and a cursor that only a rebase moves back. The rope is also the
 * lane's `PublishedText`: its reads see the revealed prefix alone, and it is the same object for
 * the lane's whole life, rebases included.
 */
export class RevealTextRope implements PublishedText {
  readonly #laneId: string;
  /**
   * The source, oldest first. Every chunk but the last holds exactly
   * `REVEAL_TEXT_CHUNK_CHARACTERS`; each is the rope's own flat copy and never changes once a
   * later one follows it, which is what makes slicing and handing it out safe.
   */
  readonly #chunks: string[] = [];
  /** The rewrites that cut revealed text, newest last: what `keepsPrefix` answers from. */
  readonly #retractions: Retraction[] = [];
  /** Where `firstIndexOf` has looked for each code unit asked about, since the last cut. */
  readonly #firstIndexScans = new Map<string, FirstIndexScan>();

  #sourceLength = 0;
  #revealedLength = 0;
  #revision = 0;
  /** The newest retraction dropped from the log; a reader older than it cannot be answered. */
  #forgottenRetractionRevision = NO_REVISION;

  public constructor(laneId: string) {
    this.#laneId = laneId;
  }

  /**
   * The single text writer. Fills the last chunk, rebuilt as one new flat copy, then copies the
   * rest in whole chunks, so no chunk holds alive a larger string it was cut from (an
   * authoritative commit's whole source). An empty append changes nothing.
   */
  public append(text: string): void {
    let consumed = 0;
    const lastIndex = this.#chunks.length - 1;
    const last = this.#chunks[lastIndex];
    if (last !== undefined && last.length < REVEAL_TEXT_CHUNK_CHARACTERS) {
      consumed = Math.min(REVEAL_TEXT_CHUNK_CHARACTERS - last.length, text.length);
      if (consumed > 0) {
        this.#chunks[lastIndex] = structuredClone(last + text.slice(0, consumed));
      }
    }
    for (let start = consumed; start < text.length; start += REVEAL_TEXT_CHUNK_CHARACTERS) {
      this.#chunks.push(structuredClone(text.slice(start, start + REVEAL_TEXT_CHUNK_CHARACTERS)));
    }
    this.#sourceLength += text.length;
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
    return this.#sliceSource(
      Math.max(0, this.#revealedLength - characterCount),
      this.#revealedLength,
    );
  }

  /**
   * Up to `characterCount` characters past the cursor, for the gate to decide whether the
   * cursor stands on a construct. Bounded by the caller rather than materializing the source.
   */
  public lookahead(characterCount: number): string {
    return this.#sliceSource(
      this.#revealedLength,
      Math.min(this.#sourceLength, this.#revealedLength + Math.max(0, characterCount)),
    );
  }

  /** Whether this rope's source is a prefix of `candidate`, compared chunk by chunk. */
  public isPrefixOf(candidate: string): boolean {
    if (candidate.length < this.#sourceLength) {
      return false;
    }
    return this.#chunks.every((chunk, index) =>
      candidate.startsWith(chunk, index * REVEAL_TEXT_CHUNK_CHARACTERS),
    );
  }

  /** How many leading characters the revealed prefix shares with `candidate`. */
  public commonRevealedPrefixLength(candidate: string): number {
    const ceiling = Math.min(this.#revealedLength, candidate.length);
    for (let start = 0; start < ceiling; start += REVEAL_TEXT_CHUNK_CHARACTERS) {
      const end = Math.min(ceiling, start + REVEAL_TEXT_CHUNK_CHARACTERS);
      const piece = this.#sliceSource(start, end);
      if (candidate.startsWith(piece, start)) {
        continue;
      }
      let shared = start;
      while (shared < end && piece[shared - start] === candidate[shared]) {
        shared += 1;
      }
      return shared;
    }
    return ceiling;
  }

  public get laneId(): string {
    return this.#laneId;
  }

  public get sourceLength(): number {
    return this.#sourceLength;
  }

  /** The revealed prefix's length: what a reader of this rope sees. */
  public get length(): number {
    return this.#revealedLength;
  }

  public get revision(): number {
    return this.#revision;
  }

  public get pendingCharacterCount(): number {
    return this.#sourceLength - this.#revealedLength;
  }

  public get isSettled(): boolean {
    return this.pendingCharacterCount === 0;
  }

  public slice(start: number, end: number = this.#revealedLength): string {
    return this.#sliceSource(
      clampedTo(start, this.#revealedLength),
      clampedTo(end, this.#revealedLength),
    );
  }

  public indexOf(character: string, from: number): number {
    const start = Math.max(0, from);
    for (
      let chunkIndex = Math.floor(start / REVEAL_TEXT_CHUNK_CHARACTERS);
      chunkIndex * REVEAL_TEXT_CHUNK_CHARACTERS < this.#revealedLength;
      chunkIndex += 1
    ) {
      const chunkStart = chunkIndex * REVEAL_TEXT_CHUNK_CHARACTERS;
      const found = this.#chunks[chunkIndex]?.indexOf(character, Math.max(0, start - chunkStart));
      if (found !== undefined && found !== -1) {
        return chunkStart + found < this.#revealedLength ? chunkStart + found : -1;
      }
    }
    return -1;
  }

  public firstIndexOf(character: string): number {
    const scan = this.#firstIndexScans.get(character);
    if (scan !== undefined && scan.foundAt !== -1) {
      return scan.foundAt;
    }
    // A code unit cannot straddle two chunks, so resuming where the last look ended misses none.
    const foundAt = this.indexOf(character, scan?.scannedTo ?? 0);
    this.#firstIndexScans.set(character, { scannedTo: this.#revealedLength, foundAt });
    return foundAt;
  }

  public chunks(): readonly string[] {
    const fullChunkCount = Math.floor(this.#revealedLength / REVEAL_TEXT_CHUNK_CHARACTERS);
    const revealed = this.#chunks.slice(0, fullChunkCount);
    const partialLength = this.#revealedLength % REVEAL_TEXT_CHUNK_CHARACTERS;
    const partialChunk = this.#chunks[fullChunkCount];
    if (partialLength > 0 && partialChunk !== undefined) {
      revealed.push(partialChunk.slice(0, partialLength));
    }
    return revealed;
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
    const unitAtStop = this.#codeUnitAt(stop);
    const unitBeforeStop = this.#codeUnitAt(stop - 1);
    if (unitAtStop === undefined || unitBeforeStop === undefined) {
      return budget;
    }
    return TRAILING_SURROGATE.test(unitAtStop) && LEADING_SURROGATE.test(unitBeforeStop)
      ? budget + 1
      : budget;
  }

  /** The source's code unit at `offset`, found by division rather than a walk. */
  #codeUnitAt(offset: number): string | undefined {
    if (offset < 0) {
      return undefined;
    }
    return this.#chunks[Math.floor(offset / REVEAL_TEXT_CHUNK_CHARACTERS)]?.[
      offset % REVEAL_TEXT_CHUNK_CHARACTERS
    ];
  }

  /**
   * The source between two offsets. One chunk's range is that chunk's slice; a longer one joins
   * the pieces, so only the range is ever built.
   */
  #sliceSource(start: number, end: number): string {
    if (end <= start) {
      return "";
    }
    const firstChunkIndex = Math.floor(start / REVEAL_TEXT_CHUNK_CHARACTERS);
    const lastChunkIndex = Math.floor((end - 1) / REVEAL_TEXT_CHUNK_CHARACTERS);
    let text = "";
    for (let chunkIndex = firstChunkIndex; chunkIndex <= lastChunkIndex; chunkIndex += 1) {
      const chunkStart = chunkIndex * REVEAL_TEXT_CHUNK_CHARACTERS;
      text += (this.#chunks[chunkIndex] ?? "").slice(
        Math.max(0, start - chunkStart),
        end - chunkStart,
      );
    }
    return text;
  }

  /**
   * Cut the source to `length` characters, rebuilding the chunk the cut falls inside as its own
   * copy so it pins none of the dropped text. The cursor never stays past the source.
   */
  #truncateSource(length: number): void {
    const keptChunkCount = Math.ceil(length / REVEAL_TEXT_CHUNK_CHARACTERS);
    this.#chunks.length = Math.min(this.#chunks.length, keptChunkCount);
    const lastIndex = keptChunkCount - 1;
    const keptInLast = length - lastIndex * REVEAL_TEXT_CHUNK_CHARACTERS;
    const last = this.#chunks[lastIndex];
    if (last !== undefined && last.length > keptInLast) {
      this.#chunks[lastIndex] = structuredClone(last.slice(0, keptInLast));
    }
    this.#sourceLength = Math.min(this.#sourceLength, length);
    this.#revealedLength = Math.min(this.#revealedLength, length);
  }

  /** Note a rewrite that cut revealed text back to `revealedLength`, under a new revision. */
  #recordRetraction(revealedLength: number): void {
    this.#revision += 1;
    this.#retractions.push({ revision: this.#revision, revealedLength });
    if (this.#retractions.length > RETRACTION_LOG_CAP) {
      this.#forgottenRetractionRevision = this.#retractions.shift()?.revision ?? NO_REVISION;
    }
    // A cut can remove what a scan found, so every scan starts again.
    this.#firstIndexScans.clear();
  }
}

/** One rewrite that cut revealed text, and how much it kept. */
interface Retraction {
  readonly revision: number;
  readonly revealedLength: number;
}

/** How far `firstIndexOf` has looked for one code unit, and where it found it, or -1. */
interface FirstIndexScan {
  readonly scannedTo: number;
  readonly foundAt: number;
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
