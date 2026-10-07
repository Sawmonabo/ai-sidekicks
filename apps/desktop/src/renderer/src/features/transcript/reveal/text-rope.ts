// One lane's text: the revealed prefix as one string, and the text past the cursor as immutable
// parts. A single growing string is never indexed or re-sliced (quadratic per append and per
// frame): a slice touches only the part under the cursor, and the revealed prefix is accumulated
// once. A part the cursor has passed is dropped, so the rope holds each character once.
// `append` is the single text writer.

/** One lane's text as a revealed prefix, unrevealed parts and a cursor that never moves back. */
export class RevealTextRope {
  readonly #laneId: string;
  /**
   * The parts the cursor has not passed, oldest first; the cursor sits inside the first. Each is
   * the rope's own copy and immutable once pushed, which is what makes slicing safe.
   */
  readonly #pendingParts: string[] = [];

  #sourceLength = 0;
  /** How far into the first pending part the cursor is. */
  #cursorOffsetInPart = 0;
  /** Every character the cursor has passed, concatenated exactly once as it passed. */
  #revealedText = "";

  public constructor(laneId: string) {
    this.#laneId = laneId;
  }

  /**
   * The single text writer. The text is copied in parts of at most `PART_CHARACTER_CAP`
   * characters, so no part holds alive a larger string it was cut from (an authoritative commit's
   * whole source) and a part the cursor is inside holds at most that much revealed text twice. An
   * empty append pushes no part: nothing grew.
   */
  public append(text: string): void {
    for (let start = 0; start < text.length; start += PART_CHARACTER_CAP) {
      this.#pendingParts.push(structuredClone(text.slice(start, start + PART_CHARACTER_CAP)));
    }
    this.#sourceLength += text.length;
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
    let passedPartCount = 0;
    while (remaining > 0) {
      const part = this.#pendingParts[passedPartCount];
      if (part === undefined) {
        break;
      }
      const availableInPart = part.length - this.#cursorOffsetInPart;
      if (availableInPart <= remaining) {
        this.#revealedText +=
          this.#cursorOffsetInPart === 0 ? part : part.slice(this.#cursorOffsetInPart);
        remaining -= availableInPart;
        passedPartCount += 1;
        this.#cursorOffsetInPart = 0;
        continue;
      }
      this.#revealedText += part.slice(
        this.#cursorOffsetInPart,
        this.#cursorOffsetInPart + remaining,
      );
      this.#cursorOffsetInPart += remaining;
      remaining = 0;
    }
    // A passed part's text now lives in the revealed prefix alone.
    this.#pendingParts.splice(0, passedPartCount);
    return budget - remaining;
  }

  /** The revealed prefix. Free: it is the accumulator `advance` already built. */
  public revealedText(): string {
    return this.#revealedText;
  }

  /**
   * The last `characterCount` characters of the revealed prefix, so the gate gets context behind
   * the cursor without concatenating the whole growing prefix each frame.
   */
  public revealedTail(characterCount: number): string {
    return characterCount >= this.#revealedText.length
      ? this.#revealedText
      : this.#revealedText.slice(this.#revealedText.length - characterCount);
  }

  /**
   * Up to `characterCount` characters past the cursor, for the gate to decide whether the
   * cursor stands on a construct. Bounded by the caller rather than materializing the source.
   */
  public lookahead(characterCount: number): string {
    let collected = "";
    let offset = this.#cursorOffsetInPart;
    for (const part of this.#pendingParts) {
      if (collected.length >= characterCount) {
        break;
      }
      collected += part.slice(offset, offset + (characterCount - collected.length));
      offset = 0;
    }
    return collected;
  }

  /**
   * Whether this rope's source is a prefix of `candidate`. Compares the revealed prefix, then
   * walks the pending parts rather than materializing the source.
   */
  public isPrefixOf(candidate: string): boolean {
    if (candidate.length < this.#sourceLength || !candidate.startsWith(this.#revealedText)) {
      return false;
    }
    // The first pending part starts behind the cursor, inside the revealed prefix.
    let offset = this.#revealedText.length - this.#cursorOffsetInPart;
    for (const part of this.#pendingParts) {
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
    return this.#revealedText.length;
  }

  public get pendingCharacterCount(): number {
    return this.#sourceLength - this.#revealedText.length;
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
    let offsetInPart = this.#cursorOffsetInPart + offsetFromCursor;
    for (const part of this.#pendingParts) {
      if (offsetInPart < part.length) {
        return part[offsetInPart];
      }
      offsetInPart -= part.length;
    }
    return undefined;
  }
}

/**
 * The most characters one part holds. Above a frame's whole budget, so a long append is crossed
 * one part or two a frame; small next to a reply, so the part the cursor is inside holds little
 * revealed text a second time.
 */
const PART_CHARACTER_CAP = 1_024;

/**
 * The first half of a UTF-16 surrogate pair, on its own. Under the `u` flag a well-formed pair
 * is one code point outside both ranges, so these match only a lone unit.
 */
const LEADING_SURROGATE = /^[\uD800-\uDBFF]$/u;

/** The second half of a UTF-16 surrogate pair, on its own. */
const TRAILING_SURROGATE = /^[\uDC00-\uDFFF]$/u;
