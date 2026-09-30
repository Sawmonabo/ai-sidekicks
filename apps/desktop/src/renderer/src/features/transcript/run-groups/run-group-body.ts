// The run group body's viewport: its height, the rows it holds, and how many it does not.
// The body scrolls inside itself so the row ceiling is a window, not a deletion. Its height is a
// CSS length validated against the engine before use (an unparsed declaration would leave the
// body unbounded), and the re-pin is the engine's `overflow-anchor`: the transcript's scroll
// offsets are written in one module, so this body has no second writer.

import { type TimelineRow } from "@ai-sidekicks/contracts";

import {
  RUN_GROUP_BODY_RETAINED_ROW_CAP,
  RUN_GROUP_VISIBLE_ROW_CAP,
} from "../structure/structure-caps.js";

/**
 * The run group body's height, as a CSS length.
 *
 * `svh` because it does not change under a retracting chrome; the `min()` stops a run group
 * taking most of a tall display, since past two dozen lines a body reads as a second feed.
 */
export const RUN_GROUP_BODY_INTRINSIC_HEIGHT = "min(38svh, 24rem)";

/**
 * The height an engine that refused the expression above takes instead: a plain `rem` length
 * every engine parses, equal to the `min()`'s second operand.
 */
export const RUN_GROUP_BODY_FALLBACK_HEIGHT = "24rem";

/** The property the length above is applied to, named once so the probe asks about it. */
export const RUN_GROUP_BODY_HEIGHT_PROPERTY = "max-height";

/**
 * Whether the engine parses one declaration, in the shape `CSS.supports` answers.
 *
 * A parameter rather than the global, so a test can drive both arms of the decision.
 */
export type CssDeclarationSupportProbe = (property: string, value: string) => boolean;

/**
 * The engine's own answer, or `false` where there is nothing to ask.
 *
 * An unknown resolves to `false` because the fallback costs a fixed height while a wrong `true`
 * leaves the body unbounded.
 */
export function supportsCssDeclaration(property: string, value: string): boolean {
  return typeof CSS === "undefined" || typeof CSS.supports !== "function"
    ? false
    : CSS.supports(property, value);
}

/**
 * The height this engine takes: the intrinsic expression, or the fallback.
 *
 * One validated expression and one that needs no validation, not a candidate list, so the
 * applied height does not depend on the order the candidates were written in.
 */
export function resolveRunGroupBodyHeight(
  probe: CssDeclarationSupportProbe = supportsCssDeclaration,
): string {
  return probe(RUN_GROUP_BODY_HEIGHT_PROPERTY, RUN_GROUP_BODY_INTRINSIC_HEIGHT)
    ? RUN_GROUP_BODY_INTRINSIC_HEIGHT
    : RUN_GROUP_BODY_FALLBACK_HEIGHT;
}

/** The head of a run group with nothing in it: one frozen value, so a memo keeps its identity. */
const EMPTY_HEAD: readonly string[] = Object.freeze([]);

/** The same nothing for the row window below, which answers in rows rather than ids. */
const EMPTY_HEAD_ROWS: readonly TimelineRow[] = Object.freeze([]);

/**
 * The rows a run group's body can still reach, collected as the fold absorbs them.
 *
 * A bounded ring, not the whole run: the body holds the rows immediately older than the ones the
 * outer list mounted, and `clippedRowCount` says how much older history lies beyond. One ring
 * of the newest two caps takes a single write per row; two queues moved rows with `shift()`,
 * which cost about 2.5 ms across a ten-thousand-row fold.
 */
export class RunGroupBodyRowWindow {
  /** The newest rows, in ring order. Never longer than the retained cap. */
  readonly #retained: TimelineRow[] = [];
  /** Where the oldest retained row sits. Zero until the ring has filled once. */
  #oldestIndex = 0;

  /** Admit one row of the run group, in log order. Constant cost, whatever the run. */
  public admit(row: TimelineRow): void {
    if (this.#retained.length < RUN_GROUP_BODY_RETAINED_ROW_CAP) {
      this.#retained.push(row);
      return;
    }
    this.#retained[this.#oldestIndex] = row;
    this.#oldestIndex = (this.#oldestIndex + 1) % RUN_GROUP_BODY_RETAINED_ROW_CAP;
  }

  /**
   * The head rows this window still holds, oldest first.
   *
   * Cut once, when the run group is sealed, not on every admit. A run group under the cap
   * answers a shared empty value so a memo over an empty head does not re-run.
   */
  public get headRows(): readonly TimelineRow[] {
    const retainedCount = this.#retained.length;
    const headCount = Math.max(0, retainedCount - RUN_GROUP_VISIBLE_ROW_CAP);
    if (headCount === 0) {
      return EMPTY_HEAD_ROWS;
    }
    const head: TimelineRow[] = [];
    for (let offset = 0; offset < headCount; offset += 1) {
      const row = this.#retained[(this.#oldestIndex + offset) % retainedCount];
      if (row === undefined) {
        throw new Error("A run group body's row ring held a gap where a row was admitted");
      }
      head.push(row);
    }
    return head;
  }
}

/**
 * How many rows of a run group fall outside the cap, from the run group's own length.
 *
 * Arithmetic, not the length of a cut list: the fold runs once per admitted event, and slicing
 * every clipped id per run group would allocate for rows nothing looks at.
 */
export function countClippedHeadRows(runGroupRowCount: number): number {
  return Math.max(0, runGroupRowCount - RUN_GROUP_VISIBLE_ROW_CAP);
}

/**
 * The row ids outside the cap: the run group's older head, in log order.
 *
 * The exact complement of the selection the feed's fold admits. Derived from the ids the
 * caller holds, so it stays right under a filter (the admitted head, never the whole run's).
 * The cut comes from {@link countClippedHeadRows}, so count and selection agree.
 */
export function listClippedHeadRowIds(rowIds: readonly string[]): readonly string[] {
  const clippedCount = countClippedHeadRows(rowIds.length);
  return clippedCount === 0 ? EMPTY_HEAD : rowIds.slice(0, clippedCount);
}
