// The composer's trailing rail: the meters slot, and the zone the discovery-only
// autocomplete and the draft indicator land in.
//
// THE METERS ARE ANOTHER PLAN'S BODY. The context-window and rate-limit meters are
// authored by the usage-meters plan and mounted here; this file builds the SLOT and
// a shell that says the slot is reserved. `OwnerSlotContract` is the three facts
// such a slot has to answer — who authors the body, what this side owes it, and
// where the shell dies — and they are developer-facing: every member names
// governance work, so no console surface renders one. What a person sees is the
// FEATURE that is absent.

import { Nothing } from "../../../console/primitives/index.js";
import { type OwnerSlotContract, type OwnerSlotProps } from "../../../console/workspace/index.js";

/**
 * The meters slot's three facts (the body is Plan-013's, task T4.5's rail).
 *
 * Stated here rather than in a reviewer's memory, which is the whole reason the
 * contract is a type: a shell with no named deletion point is a shell that outlives
 * the body it was standing in for.
 *
 * The governance id sits in this comment and not in the value. Every member below
 * is a string a program holds at runtime, and the repository's standing rule keeps
 * plan, spec, and task ids out of runtime strings — the prose names the owning
 * work, and a reader who needs the id reads it here.
 */
const METERS_SLOT_CONTRACT: OwnerSlotContract = {
  owningTask: "the usage-meters plan",
  mountObligation:
    "the composer supplies the rail's placement and its accessible grouping; the body reads its own figures and formats every one of them through the console's wire-figure chokepoint",
  deleteShellIn: "the PR that mounts the usage-meters body into this rail",
};

/**
 * One plan-owned slot, rendered the mounting family's own way.
 *
 * There is deliberately no shared owner-slot component in the console — the empty
 * state, the placement, and the grouping are each the mounting family's decision,
 * and a shared body would put all three in one file six families then widen.
 */
function ComposerMeterSlot(props: OwnerSlotProps<React.ReactNode>): React.JSX.Element {
  if (props.body !== undefined) {
    return <div className="meridian-composer__meters">{props.body}</div>;
  }
  return (
    <div className="meridian-composer__meters">
      <Nothing
        kind="not-checked"
        title="The context and rate-limit meters are not mounted here yet."
        detail="The rail is reserved for them rather than stubbed, so no figure on screen is one the console made up."
      />
    </div>
  );
}

export function ComposerAccessoryRail(): React.JSX.Element {
  return (
    <div className="meridian-composer__accessories">
      {/* `body: undefined` is not a placeholder for a lookup this file skipped —
          the meters have no seat to be read out of, because the body arrives by
          its owning plan mounting it here. The slot renders the reserved state
          until it does. */}
      <ComposerMeterSlot contract={METERS_SLOT_CONTRACT} body={undefined} />
      <Nothing
        kind="not-checked"
        title="Autocomplete and draft state have not been built yet."
        detail="Completion offers only what the console has already read, so it arrives with the reads it draws on."
      />
    </div>
  );
}
