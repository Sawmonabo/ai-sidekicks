// Who directed this run, what they asked for, and whether it landed — including
// the attempts that did not.
//
// `Spec-023 §Signature Feature Composition Sketches`' Runs View renders
// "intervention history per Spec-004" and settles nothing further. WHAT THE HISTORY
// SHOWS IS THIS COMPONENT'S OWN RULE, because no committed document states it:
// every intervention in order with its terminal state from the six-member
// `InterventionState`, the `origin` discriminator, the admitting principal on the
// participant arm, the rejection reason verbatim on a `rejected` row, and the
// disposition on a `degraded` rollback.
//
// WHAT THE WIRE SUPPLIES AND WHAT IT DOES NOT. The rows this surface can honestly
// render come from `InterventionRequestResponse`, which carries the intervention
// id, the type, the state, the advanced run version, the rejection reason, and the
// rollback result. `interventions.origin` and `interventions.admitting_principal_id`
// are DURABLE columns with no registered read anywhere in the corpus — no method,
// no event payload — so this surface renders neither and says so, rather than
// inferring an origin from an absent field. `Spec-023 §Rules every console surface
// obeys` makes the projection fail closed — an unrecognized enum member "renders as
// the explicit unrecognized row or badge, never as a guess" — and the honest form
// of that for a member no wire carries at all is an absence with its reason.
//
// FAILED ATTEMPTS ARE PART OF THE RECORD. A refused control is a row, not an
// omission: interventions require durable audit records even when they fail, and a
// history that showed only what worked would be the wrong shape of the same claim.
//
// A DEGRADED SETTLEMENT IS NEVER A SUCCESS. The rollback arm renders through
// `rollback-result.ts`'s exhaustive reading, so a degraded disposition arrives with
// its own words, its own daemon-supplied positions, and — on the three arms that
// carry them — both never-silent file enumerations.
//
// A REWIND THAT TOUCHED THE WORKING TREE IS DISCLOSED HERE AND NOWHERE ELSE. The
// three dispositions that carry enumerations ride this list, so this is the surface
// that owes a person the two path lists — and every path in them is a control,
// because a path a person can see and cannot take is a path they retype.

import { Nothing } from "../../../primitives/index.js";
import type { ConsoleBridge } from "../../../bridge/index.js";
import { useEnumeratedPathAction } from "../controls/enumerated-path-action.js";
import type { RunControlRecord } from "../controls/run-control-surface.js";
import { InterventionRow } from "./InterventionRow.js";

export interface InterventionHistoryProps {
  /** Newest last, matching the ledger's reading direction. */
  readonly records: readonly RunControlRecord[];
  /** Rows for this run alone. */
  readonly runId: string;
  /** For the path action a settled rollback's enumerations offer. */
  readonly bridge: ConsoleBridge;
}

export function InterventionHistory(props: InterventionHistoryProps): React.JSX.Element {
  // Held for the whole history rather than per row: one host call is in flight at a
  // time and one refusal is the answer to the last one, so a per-row copy would be
  // as many identical pieces of state as the run has interventions.
  const pathAction = useEnumeratedPathAction(props.bridge);
  const rows = props.records.filter((record) => record.runId === props.runId);
  if (rows.length === 0) {
    return (
      <Nothing
        kind="not-checked"
        placement="surface"
        title="No intervention has been directed at this run from this window."
        detail="The durable record — every intervention on this run, whoever raised it, with the origin and the admitting principal — is held by the daemon and has no read the console can call yet. What appears here is what this window asked for and what came back."
      />
    );
  }
  return (
    <ol className="meridian-interventions">
      {rows.map((record) => (
        <InterventionRow
          key={record.recordId}
          record={record}
          onPathAction={pathAction.copyPath}
          pathActionRefusal={pathAction.refusal}
        />
      ))}
    </ol>
  );
}
