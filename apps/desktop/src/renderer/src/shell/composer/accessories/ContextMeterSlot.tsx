// The context-window meter's seat — the composer mounts it, another plan authors it.
//
// THE METER IS NOT THE COMPOSER'S BODY TO WRITE. The usage meters are one of the
// holes the console's owner-slot declaration was minted for, and the plan that owns
// them authors the meter, the rate-limit indicator, and the compaction control in
// its own subtree. What this family owns is the seat: where the meter sits on the
// rail, and the reading the composer already folds off the session timeline.
//
// SO THE COMPOSER SUPPLIES THE READING AND THE BODY OWNS THE RENDER. That is why
// the body is a COMPONENT rather than a rendered node: a node would mean the owning
// plan reaching for the timeline a second time, and the fold that answers this
// question is the rail's — one selector, three readings, one subscription.
//
// GOVERNANCE IDS LIVE IN THIS COMMENT AND NOT IN THE VALUE. Every member of the
// contract below is a string a program holds at runtime, and the repository keeps
// plan, spec, and task ids out of runtime strings — so the prose names the owning
// work and a reader who needs the identifier reads it here: the meter body is
// Plan-013's, mounted under the obligation Plan-023 Phase 6 records for it.

import type { OwnerSlotContract, OwnerSlotProps } from "../../../console/workspace/index.js";
import { ContextMeter, type ContextMeterProps } from "./ContextMeter.js";

/** The three facts this seat answers. Developer-facing; never rendered. */
export const CONTEXT_METER_SLOT_CONTRACT: OwnerSlotContract = {
  owningTask: "the usage-meters plan's context-window meter",
  mountObligation:
    "the composer supplies the meter's placement in the accessory rail and the newest context-window reading it folds off the session timeline, absent while the daemon has reported none; the body owns the render, the threshold copy, and every figure it draws",
  deleteShellIn: "the PR that mounts the context-window meter into this seat",
};

/** What the owning plan mounts here: a component taking the reading the rail folds. */
export type ContextMeterBody = React.ComponentType<ContextMeterProps>;

/**
 * The seat, rendered without a wrapper of its own.
 *
 * Placement is the rail's meters row and not an element this file adds: a wrapper
 * would nest the meter one level deeper than the row that lays it out, and the
 * composer's half of the obligation is WHERE the seat sits, which the row already
 * says. The shell below is what renders while nobody has filled the seat.
 */
export function ContextMeterSlot(
  props: OwnerSlotProps<ContextMeterBody> & ContextMeterProps,
): React.JSX.Element {
  const MountedBody = props.body ?? ContextMeter;
  return <MountedBody reading={props.reading} />;
}
