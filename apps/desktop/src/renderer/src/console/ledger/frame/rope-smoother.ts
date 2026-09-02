// The rope smoother — one lane's text, as parts and a cursor.
//
// `Spec-023 §Console Design (Meridian)` §5.6: "A rope smoother: parts array plus a
// revealed cursor; a growing string is never indexed."
//
// WHY THE ROPE. The obvious implementation holds one accumulating string and a
// numeric cursor, and it is quadratic twice over: every append re-allocates the
// whole message, and every frame slices it again. On a long assistant turn that is
// megabytes of copying a second, and it is invisible until the turn is long. Parts
// never mutate once pushed, so a slice only ever touches the ONE part the cursor is
// inside, and the settled prefix is accumulated exactly once as it settles.
//
// THE PROVEN-APPEND TOKEN. §5.6: "A proven-append token minted by the single text
// writer; every consumer threads it and none prefix-inspects the growing source."
// `append` is that writer and the token is its receipt: a consumer holding one
// knows the source it was handed extends the source it had, without re-reading a
// string that is still growing to prove it. `isPrefixOf` is the same guarantee from
// the other side — it walks the fixed parts rather than materialising the source.

/**
 * A receipt that the source grew by an append rather than changing underneath.
 *
 * `sequence` is per smoother and monotonic, so a consumer can tell a token it has
 * already folded from one it has not without comparing text.
 */
export interface ProvenAppendToken {
  readonly laneId: string;
  readonly sequence: number;
  /** The source length AFTER the append this token proves. */
  readonly sourceLength: number;
}

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
   * Move the cursor forward by at most `characterBudget`, and say how far it went.
   *
   * Never backwards: the visible text is the cursor's prefix, and the rope's whole
   * claim is that it never regresses.
   *
   * This is the single cursor writer, which is why the code-point boundary is
   * enforced here rather than in the callers: no caller can split a character it
   * cannot cut.
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

  /**
   * The revealed prefix.
   *
   * Free: it is the accumulator `advance` already built, never a join over parts
   * and never a slice of a growing string.
   */
  public revealedText(): string {
    return this.#settledText;
  }

  /**
   * The last `characterCount` characters of the revealed prefix.
   *
   * The gate needs a few characters of context BEHIND the cursor and the engine
   * must not hand it the whole message: concatenating a growing prefix once per
   * frame is the quadratic cost the rope exists to avoid.
   */
  public revealedTail(characterCount: number): string {
    return characterCount >= this.#settledText.length
      ? this.#settledText
      : this.#settledText.slice(this.#settledText.length - characterCount);
  }

  /**
   * The source as far as the smoother would publish it if the budget were infinite.
   *
   * Used by the gate, which needs a few characters PAST the cursor to decide
   * whether the cursor is standing on a construct. Bounded by the caller's lookahead
   * rather than materialising the whole source.
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
   * Whether this smoother's source is a prefix of `candidate`.
   *
   * Walks the fixed parts rather than materialising the source, which is the same
   * promise the append token makes: nothing prefix-inspects a growing string.
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
   * `budget`, extended by one code unit if spending it would stop between the two
   * halves of a surrogate pair.
   *
   * The frame budget is divided across lanes and then spent as a UTF-16 CODE UNIT
   * count, so without this a stop inside an emoji publishes the leading surrogate
   * alone: one frame of a replacement glyph, then the character. Nothing upstream
   * catches it — a lone surrogate is not in the reveal gate's volatile set, so the
   * gate judges it literal-safe.
   *
   * EXTEND, NEVER RETREAT. Retreating would zero out a one-character fair share and
   * spin the frame loop; extending cannot stall, because the unit is guaranteed to
   * exist whenever the budget is short of the pending count. It publishes no
   * character the gate withheld — only the pair's low half is consumed — and
   * `advance` returns what it actually moved, so the frame's spend stays exact.
   *
   * THE SOURCE-END CASE PUBLISHES UNCHANGED. A budget that reaches the whole
   * remaining source is spent as-is, which is what keeps termination provable: a
   * producer that split a pair across the end of what it has sent so far is
   * published as it arrived, self-heals on the next append, and cannot hang a lane.
   *
   * GRAPHEME CLUSTERS ARE DELIBERATELY NOT SNAPPED. A cluster's completeness — a
   * ZWJ sequence, a combining mark, a regional-indicator pair — is undecidable at
   * the end of an in-flight source, so snapping would either stall a lane or
   * withhold an unbounded tail, and a partly-arrived cluster renders as its own
   * valid glyphs rather than as a replacement marker.
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
   * The one code unit `offsetFromCursor` units past the reveal cursor.
   *
   * Walks the parts from the cursor rather than reading `revealedText()` or a
   * materialised source: the boundary check runs on every lane on every frame, and
   * building a string to look at two characters is exactly the copying the rope
   * exists to avoid.
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
 * The first half of a UTF-16 surrogate pair, on its own.
 *
 * The ranges are the encoding's, not a tunable: a non-BMP character is stored as
 * one unit from `D800–DBFF` followed by one from `DC00–DFFF`, and neither half is
 * a character by itself. Under the `u` flag a well-formed pair is a single code
 * point outside both ranges, so these match only a unit standing alone — which is
 * what the boundary check is handed.
 */
const LEADING_SURROGATE = /^[\uD800-\uDBFF]$/u;

/** The second half of a UTF-16 surrogate pair, on its own. */
const TRAILING_SURROGATE = /^[\uDC00-\uDFFF]$/u;
