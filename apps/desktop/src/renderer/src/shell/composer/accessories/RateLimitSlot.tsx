// The rate-limit indicator's seat — the composer mounts it, another plan authors it.
//
// The second of the two meters the usage plan owns. The seat exists for the same
// reason its sibling does: the reading is the rail's fold and the render is not the
// composer's to write, so the composer hands over the readings and the clock reading
// a countdown is measured against, and the body decides what a person sees.
//
// WHY THE CLOCK READING IS PART OF THE OBLIGATION. A body that read a clock itself
// would tick on its own schedule, and the console's relative times are measured
// against ONE clock reading per render so a screenshot is byte-stable and a fixture
// scenario's frozen clock reaches every surface. Handing the instant over is what
// keeps that true through the seat.
//
// GOVERNANCE IDS LIVE IN THIS COMMENT AND NOT IN THE VALUE, as they do in every
// contract in this directory: the indicator body is Plan-013's, mounted under the
// obligation Plan-023 Phase 6 records for it.

import type { OwnerSlotContract, OwnerSlotProps } from "../../../console/seats/index.js";
import { RateChips, type RateChipsProps } from "./RateChips.js";

/** The three facts this seat answers. Developer-facing; never rendered. */
export const RATE_LIMIT_SLOT_CONTRACT: OwnerSlotContract = {
  owningTask: "the usage-meters plan's rate-limit indicator",
  mountObligation:
    "the composer supplies the indicator's placement in the accessory rail, the folded rate-limit readings keyed by account and limit window, and the one clock reading a countdown is measured against; the body owns the render, the visibility bands, and the tones",
  deleteShellIn: "the PR that mounts the rate-limit indicator into this seat",
};

/** What the owning plan mounts here: a component taking the readings the rail folds. */
export type RateLimitBody = React.ComponentType<RateChipsProps>;

/**
 * The seat. Null-returning in both arms, because a session whose quotas are all
 * healthy earns no pixel — the absence of a chip is not a health reading, and the
 * seat adds no element that would make it look like one.
 */
export function RateLimitSlot(
  props: OwnerSlotProps<RateLimitBody> & RateChipsProps,
): React.JSX.Element | null {
  const MountedBody = props.body ?? RateChips;
  return <MountedBody readings={props.readings} nowMilliseconds={props.nowMilliseconds} />;
}
