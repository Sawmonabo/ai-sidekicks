// One lane's text as immutable parts plus a reveal cursor. A single growing string is never
// indexed or re-sliced (quadratic per append and per frame): a slice touches only the part under
// the cursor, and the settled prefix is accumulated once. `append` is the single text writer and
// its token proves growth without re-reading the source.

/**
 * A receipt that the source grew by an append rather than changing underneath.
 *
 * `sequence` is per smoother and monotonic, so a consumer can tell a token it has
 * already folded from one it has not without comparing text.
 */
export interface ProvenAppendToken {
  readonly laneId: string;
  readonly sequence: number;
  /** The source length after the append this token proves. */
  readonly sourceLength: number;
}

/** One lane's text as immutable parts and a cursor that never moves backwards. */
export class RopeSmoother {
  readonly #laneId: string;
  /** Immutable once pushed. Nothing mutates a part, which is what makes slicing safe. */
  readonly #parts: string[] = [];

  #sourceLength = 0;
  #revealedLength = 0;
  /** Which part the cursor is inside, and how far into it. */
  #cursorPartIndex = 0;
  #cursorOffsetInPart = 0;
  /** Every part the cursor has passed, concatenated exactly once as it passed. */
  #settledText = "";
  #sequence = 0;

  public constructor(laneId: string) {
    this.#laneId = laneId;
  }

  /** The single text writer. Empty appends mint no token — nothing grew. */
  public append(text: string): ProvenAppendToken | undefined {
    if (text.length === 0) {
      return undefined;
    }
    this.#parts.push(text);
    this.#sourceLength += text.length;
    this.#sequence += 1;
    return { laneId: this.#laneId, sequence: this.#sequence, sourceLength: this.#sourceLength };
  }

  /**
   * Move the cursor forward by at most `characterBudget` and return how far it went. Never
   * backwards. The single cursor writer, so the code-point boundary is enforced here.
   */
  public advance(characterBudget: number): number {
    const budget = this.#snappedToCodePointBoundary(
      Math.max(0, Math.min(characterBudget, this.pendingCharacterCount)),
    );
    let remaining = budget;
    while (remaining > 0) {
      const part = this.#parts[this.#cursorPartIndex];
      if (part === undefined) {
        break;
      }
      const availableInPart = part.length - this.#cursorOffsetInPart;
      if (availableInPart <= remaining) {
        this.#settledText +=
          this.#cursorOffsetInPart === 0 ? part : part.slice(this.#cursorOffsetInPart);
        remaining -= availableInPart;
        this.#cursorPartIndex += 1;
        this.#cursorOffsetInPart = 0;
        continue;
      }
      this.#settledText += part.slice(
        this.#cursorOffsetInPart,
        this.#cursorOffsetInPart + remaining,
      );
      this.#cursorOffsetInPart += remaining;
      remaining = 0;
    }
    const advanced = budget - remaining;
    this.#revealedLength += advanced;
    return advanced;
  }

  /** The revealed prefix. Free: it is the accumulator `advance` already built. */
  public revealedText(): string {
    return this.#settledText;
  }

  /**
   * The last `characterCount` characters of the revealed prefix, so the gate gets context behind
   * the cursor without concatenating the whole growing prefix each frame.
   */
  public revealedTail(characterCount: number): string {
    return characterCount >= this.#settledText.length
      ? this.#settledText
      : this.#settledText.slice(this.#settledText.length - characterCount);
  }

  /**
   * Up to `characterCount` characters past the cursor, for the gate to decide whether the
   * cursor stands on a construct. Bounded by the caller rather than materializing the source.
   */
  public lookahead(characterCount: number): string {
    let collected = "";
    let partIndex = this.#cursorPartIndex;
    let offset = this.#cursorOffsetInPart;
    while (collected.length < characterCount) {
      const part = this.#parts[partIndex];
      if (part === undefined) {
        break;
      }
      collected += part.slice(offset, offset + (characterCount - collected.length));
      partIndex += 1;
      offset = 0;
    }
    return collected;
  }

  /**
   * Whether this smoother's source is a prefix of `candidate`. Walks the fixed parts rather
   * than materializing the source.
   */
  public isPrefixOf(candidate: string): boolean {
    if (candidate.length < this.#sourceLength) {
      return false;
    }
    let offset = 0;
    for (const part of this.#parts) {
      if (!candidate.startsWith(part, offset)) {
        return false;
      }
      offset += part.length;
    }
    return true;
  }

  public get laneId(): string {
    return this.#laneId;
  }

  public get sourceLength(): number {
    return this.#sourceLength;
  }

  public get revealedLength(): number {
    return this.#revealedLength;
  }

  public get pendingCharacterCount(): number {
    return this.#sourceLength - this.#revealedLength;
  }

  public get isSettled(): boolean {
    return this.pendingCharacterCount === 0;
  }

  /**
   * `budget`, extended by one code unit if spending it would stop between the halves of a
   * surrogate pair; otherwise the gate would judge a lone leading surrogate literal-safe and
   * publish it for a frame. Extends and never retreats, so a one-character share cannot spin
   * the frame loop. A budget reaching the end of the source is spent as-is, so a pair split
   * across what the producer has sent so far publishes as it arrived and heals on the next
   * append. Grapheme clusters are not snapped: their completeness is undecidable at the end of
   * an in-flight source, and a partial cluster renders as valid glyphs.
   */
  #snappedToCodePointBoundary(budget: number): number {
    if (budget === 0 || budget >= this.pendingCharacterCount) {
      return budget;
    }
    const unitAtStop = this.#codeUnitAtCursorOffset(budget);
    const unitBeforeStop = this.#codeUnitAtCursorOffset(budget - 1);
    if (unitAtStop === undefined || unitBeforeStop === undefined) {
      return budget;
    }
    return TRAILING_SURROGATE.test(unitAtStop) && LEADING_SURROGATE.test(unitBeforeStop)
      ? budget + 1
      : budget;
  }

  /**
   * The code unit `offsetFromCursor` units past the cursor. Walks the parts rather than building
   * a string: it runs for every lane on every frame.
   */
  #codeUnitAtCursorOffset(offsetFromCursor: number): string | undefined {
    let partIndex = this.#cursorPartIndex;
    let offsetInPart = this.#cursorOffsetInPart + offsetFromCursor;
    while (partIndex < this.#parts.length) {
      const part = this.#parts[partIndex];
      if (part === undefined) {
        return undefined;
      }
      if (offsetInPart < part.length) {
        return part[offsetInPart];
      }
      offsetInPart -= part.length;
      partIndex += 1;
    }
    return undefined;
  }
}

/**
 * The first half of a UTF-16 surrogate pair, on its own. Under the `u` flag a well-formed pair
 * is one code point outside both ranges, so these match only a lone unit.
 */
const LEADING_SURROGATE = /^[\uD800-\uDBFF]$/u;

/** The second half of a UTF-16 surrogate pair, on its own. */
const TRAILING_SURROGATE = /^[\uDC00-\uDFFF]$/u;
