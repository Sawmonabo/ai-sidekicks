// The compaction control's seat — the composer addresses it, another plan authors it.
//
// The third body the usage plan owns, and the one whose obligation is largest,
// because the composer supplies an ADDRESS and not only a figure: the run this
// composer is pointed at is the same run the chip rail names and the send bar acts
// on, so a person reading "steer Ada's turn" and pressing Compact reach one run.
// A body that resolved its own target would be a second answer to that question.
//
// WHAT THE BODY INHERITS ABOUT SETTLEMENT. The control settles on the compaction
// call's OWN reply — in every arm, the rejection included — and never on a
// `usage.context_compacted` row arriving. The two are different facts: the call says
// what the driver answered, and the row is the only evidence the context was
// actually compacted. The seat states that here so the body inherits the rule rather
// than rediscovering it, and it is why the completed reading is passed in rather
// than derived from the reply.
//
// GOVERNANCE IDS LIVE IN THIS COMMENT AND NOT IN THE VALUE, as they do in every
// contract in this directory: the control body is Plan-013's, mounted under the
// obligation Plan-023 Phase 6 records for it.

import type { OwnerSlotContract, OwnerSlotProps } from "../../../../console/seats/index.js";
import { CompactionControl, type CompactionControlProps } from "./CompactionControl.js";

/** The three facts this seat answers. Developer-facing; never rendered. */
export const COMPACTION_SLOT_CONTRACT: OwnerSlotContract = {
  owningTask: "the usage-meters plan's participant-triggered compaction control",
  mountObligation:
    "the composer supplies the addressed run — its own address, the one the chip rail renders — the bound driver's capability state, the control's placement beside the meters, its accessible framing, and the newest compaction boundary recorded for that run; the body owns the render and the dispatch, and settles the control on the compaction call's own reply rather than on a compaction row arriving",
  deleteShellIn: "the PR that mounts the compaction control into this seat",
};

/** What the owning plan mounts here: a component taking the address the rail resolves. */
export type CompactionBody = React.ComponentType<CompactionControlProps>;

/**
 * The seat. Both arms may render nothing: a driver that cannot compact has nothing
 * to say about compaction, which is an absence rather than a disabled control.
 */
export function CompactionSlot(
  props: OwnerSlotProps<CompactionBody> & CompactionControlProps,
): React.JSX.Element | null {
  const MountedBody = props.body ?? CompactionControl;
  return (
    <MountedBody
      bridge={props.bridge}
      sessionId={props.sessionId}
      targetRunId={props.targetRunId}
      capability={props.capability}
      completedBoundarySequence={props.completedBoundarySequence}
    />
  );
}
