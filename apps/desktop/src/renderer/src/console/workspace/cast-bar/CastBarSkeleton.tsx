// What the bar draws while the session is opening.
//
// IT DRAWS CHIPS, AND THAT IS THE WHOLE POINT. The loading arm used to be a single
// line of text, so the bar was one line of prose tall while the session opened and
// one line of CHIPS tall a moment later — every surface below it moved down the page
// at the exact instant a person was reaching for something. Skeleton chips are the
// same height as the chips they stand in for, so the bar's height is settled before
// the first row arrives and nothing under it jumps.
//
// HOW MANY. The count is the caller's, from the membership slice it already holds,
// and it is a HINT rather than a promise: a session's cast is its members plus its
// attached agents, so the real bar is usually wider than this and never narrower.
// Sizing from the members alone is the honest floor — it is a number the console was
// given rather than one it guessed — and it is bounded on both sides: at least one,
// because a session always has the participant who owns it, and never more than the
// chip cap, because past the cap the real bar folds into "+N" and a skeleton wider
// than the bar it stands in for would ITSELF be the jump this exists to prevent.
//
// NO COUNT AT ALL is the ordinary case rather than an error: a window opening at a
// route it restored from the last run has no membership slice, because that slice
// arrives on the create response. One chip is what it draws then — the floor, for the
// same reason the floor is one.
//
// THEY ARE NOT ANNOUNCED. `aria-hidden` on the list: a skeleton is the shape of an
// answer and not an answer, so a screen reader is told the bar is loading once, in
// words, by the absence beside it — never "three participants" for three grey pills
// naming nobody.

import { CAST_BAR_CHIP_CAP } from "../../core/index.js";
import { Nothing } from "../../primitives/index.js";

export interface CastBarSkeletonProps {
  /**
   * How many members the caller was told this session has, when it was told.
   *
   * `undefined` is the ordinary case and not a gap — see the module header.
   */
  readonly expectedMemberCount?: number | undefined;
}

export function CastBarSkeleton(props: CastBarSkeletonProps): React.JSX.Element {
  const chipCount = skeletonChipCount(props.expectedMemberCount);
  return (
    <>
      <ul className="meridian-cast-bar__members" aria-hidden="true">
        {Array.from({ length: chipCount }, (_unused, index) => (
          <li key={index}>
            <span className="meridian-cast-chip meridian-cast-chip--skeleton" />
          </li>
        ))}
      </ul>
      <Nothing kind="not-loaded" title="This session is opening." />
    </>
  );
}

/**
 * The floor, the cap, and the caller's number between them.
 *
 * Exported for its own test rather than asserted through the DOM: the rule is three
 * clauses over one integer, and driving it through a render would test React's list
 * rendering to establish arithmetic.
 */
export function skeletonChipCount(expectedMemberCount: number | undefined): number {
  if (expectedMemberCount === undefined || !Number.isFinite(expectedMemberCount)) {
    return 1;
  }
  return Math.min(Math.max(Math.trunc(expectedMemberCount), 1), CAST_BAR_CHIP_CAP);
}
