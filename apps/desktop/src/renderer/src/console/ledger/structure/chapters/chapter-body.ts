// The chapter body's own viewport: how tall it is, what it holds, and what it says
// about the rows it does not hold.
//
// WHY A CHAPTER SCROLLS INSIDE ITSELF. `core/constants.ts` fixes the chapter's row
// ceiling and says why in its own words — the cap "is not about what fits on screen,
// it is about how many rows one run may mount at once while three sibling runs stream
// beside it". Until this module the ceiling had only one half of that: the rows past
// it were dropped out of the feed and reported as a figure, so a run's older head was
// counted and unreachable. A body that scrolls inside its own bounded viewport is what
// makes the ceiling a WINDOW rather than a deletion — the outer list still mounts one
// screen of a run, and the rows above it are a scroll away instead of a number.
//
// THREE DECISIONS LIVE HERE.
//
//   • **The height is a CSS length the engine agreed to.** It is stated in viewport
//     units so a chapter takes the same share of a tall pane and a short one, and it
//     is VALIDATED before it is applied: an engine that does not parse the expression
//     drops the whole declaration, which would leave the body unbounded and put a
//     4,000-row run back in the outer list. The fallback is a plain `rem` length that
//     every engine parses, so the failure mode is a body of a fixed height rather
//     than no body bound at all.
//   • **The re-pin is the engine's scroll anchoring, declared rather than assumed.**
//     A chapter's body changes height whenever a row above the reading position
//     settles, and the reading position has to survive that. `overflow-anchor` is the
//     mechanism the platform gives for exactly this, and the ledger's scroll offsets
//     are written in one module (`frame/scroll/scroll-chokepoint.ts`) — so a second
//     JavaScript writer of a scroll offset is not available to this body and would be
//     the wrong answer even if it were. What this module owns is the declaration and
//     the rule that the fade overlay is never the anchor.
//   • **Which rows the body holds** — the head outside the cap, newest first to the
//     eye's own order, bounded by the same ceiling, with the remainder named.

import { type TimelineRow } from "@ai-sidekicks/contracts";

import { CHAPTER_VISIBLE_ROW_CAP } from "../../../core/index.js";

/**
 * The chapter body's height, as a CSS length.
 *
 * `svh` rather than `vh` because a desktop pane is not the visual viewport and the
 * small-viewport unit is the one that does not change under a retracting chrome. The
 * `min()` keeps a chapter from taking most of a tall display: past two dozen lines a
 * body stops being a passage somebody reads and becomes a second feed.
 */
export const CHAPTER_BODY_INTRINSIC_VIEWPORT_HEIGHT = "min(38svh, 24rem)";

/**
 * The height an engine that refused the expression above takes instead.
 *
 * A plain `rem` length, which every engine this console runs on parses. It is the
 * `min()`'s own second operand rather than a third figure, so the bounded body is the
 * same height on the fallback path as it is on a short display.
 */
export const CHAPTER_BODY_FALLBACK_VIEWPORT_HEIGHT = "24rem";

/** The property the length above is applied to, named once so the probe asks about it. */
export const CHAPTER_BODY_HEIGHT_PROPERTY = "max-height";

/**
 * Whether the engine parses one declaration — the shape `CSS.supports` answers.
 *
 * Taken as a parameter rather than read from the global inside the resolver, so both
 * arms of the decision are drivable by a test on a host whose engine only ever answers
 * one of them.
 */
export type CssDeclarationSupportProbe = (property: string, value: string) => boolean;

/**
 * The engine's own answer, or `false` where there is nothing to ask.
 *
 * A host without `CSS.supports` is answered `false` rather than assumed capable: the
 * cost of the fallback is a fixed height and the cost of a wrong `true` is a body with
 * no bound at all, so the unknown resolves to the side that still bounds the body.
 */
export function supportsCssDeclaration(property: string, value: string): boolean {
  return typeof CSS === "undefined" || typeof CSS.supports !== "function"
    ? false
    : CSS.supports(property, value);
}

/**
 * The height this engine takes: the intrinsic expression, or the fallback.
 *
 * One expression validated and one that needs no validation, rather than a list walked
 * until something sticks — a chain would make the applied height depend on the order
 * somebody happened to write the candidates in.
 */
export function resolveChapterBodyViewportHeight(
  probe: CssDeclarationSupportProbe = supportsCssDeclaration,
): string {
  return probe(CHAPTER_BODY_HEIGHT_PROPERTY, CHAPTER_BODY_INTRINSIC_VIEWPORT_HEIGHT)
    ? CHAPTER_BODY_INTRINSIC_VIEWPORT_HEIGHT
    : CHAPTER_BODY_FALLBACK_VIEWPORT_HEIGHT;
}

/**
 * The head of a chapter with nothing in it. One frozen value, so a caller that
 * memoizes on the result is not handed a new identity for the same nothing.
 */
const EMPTY_HEAD: readonly string[] = Object.freeze([]);

/**
 * The row ids outside the cap — the chapter's older head, in log order.
 *
 * The exact complement of the selection the feed's fold admits, so the two together
 * are the chapter's rows and neither drops one. It is derived from the ids the CALLER
 * holds rather than from the sealed chapter, which is what keeps it right under a
 * narrowing: a filtered chapter carries the admitted ids, so the head this returns is
 * the admitted head and never the whole run's.
 */
export function chapterClippedHeadRowIds(rowIds: readonly string[]): readonly string[] {
  return rowIds.length <= CHAPTER_VISIBLE_ROW_CAP
    ? EMPTY_HEAD
    : rowIds.slice(0, rowIds.length - CHAPTER_VISIBLE_ROW_CAP);
}

/**
 * The rows a chapter's body can still reach, collected as the fold absorbs them.
 *
 * WHY A BOUNDED COLLECTOR AND NOT THE WHOLE RUN. The body is a viewport and not an
 * archive: it holds the rows immediately older than the ones the outer list mounted,
 * which is what a person scrolls up into. Keeping every row of a 4,000-row run so a
 * 120-row window could be cut from it would double the fold's per-chapter references
 * to hold rows nothing can draw. Two bounded arrays hold what the body needs and the
 * chapter's own `clippedRowCount` says how much older history there is beyond them,
 * so the body can name what it does not hold rather than implying it does not exist.
 */
export class ChapterBodyRowWindow {
  /** The newest rows, which the outer list mounts. Bounded by the chapter's cap. */
  readonly #mounted: TimelineRow[] = [];
  /** The rows the mounted window pushed out, newest last. Bounded by the same cap. */
  readonly #head: TimelineRow[] = [];

  /** Admit one row of the chapter, in log order. */
  public admit(row: TimelineRow): void {
    this.#mounted.push(row);
    if (this.#mounted.length <= CHAPTER_VISIBLE_ROW_CAP) {
      return;
    }
    const displaced = this.#mounted.shift();
    if (displaced === undefined) {
      return;
    }
    this.#head.push(displaced);
    if (this.#head.length > CHAPTER_VISIBLE_ROW_CAP) {
      this.#head.shift();
    }
  }

  /**
   * The head rows this window still holds, oldest first.
   *
   * The array itself, not a copy: it is sealed onto the chapter and read, never
   * written, and a copy per seal would allocate a second bounded array per chapter on
   * every pass of a fold that already runs once per admitted event.
   */
  public get headRows(): readonly TimelineRow[] {
    return this.#head;
  }
}
