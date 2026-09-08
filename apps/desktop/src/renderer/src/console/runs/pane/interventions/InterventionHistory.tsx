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
// THE HISTORY IS THE RUN'S RECORD, NOT THIS WINDOW'S DISPATCH LOG. Two sources, two
// lists, and the surface says which is which. The daemon's durable rows arrive
// through the growth port's run-scoped read — `interventions.origin`, the admitting
// principal required exactly on the participant arm, the queue item the intervention
// admitted, and the decrypted directive where the key still opens it — so an
// intervention raised by another participant, by the system, or by this participant
// in a previous window appears here. Beside them sit the calls THIS window made,
// which carry a settlement the durable read does not: the rollback result union and
// its two never-silent file enumerations.
//
// THE TWO ARE NEVER MERGED. They describe the same intervention from two sides, and
// matching them would mean matching on an id this window does not learn until its own
// call settles. `Spec-023 §Rules every console surface obeys` makes the projection
// fail closed — an unrecognized enum member "renders as the explicit unrecognized row
// or badge, never as a guess" — and a correspondence the console cannot read is
// exactly the guess it may not make.
//
// FAILED ATTEMPTS ARE PART OF THE RECORD. A refused control is a row, not an
// omission: interventions require durable audit records even when they fail, and a
// history that showed only what worked would be the wrong shape of the same claim.
//
// A DEGRADED SETTLEMENT IS NEVER A SUCCESS. The rollback arm renders through
// `controls/rollback/`'s exhaustive reading, so a degraded disposition arrives with
// its own words, its own daemon-supplied positions, and — on the three arms that
// carry them — both never-silent file enumerations.
//
// A REWIND THAT TOUCHED THE WORKING TREE IS DISCLOSED HERE AND NOWHERE ELSE. The
// three dispositions that carry enumerations ride this list, so this is the surface
// that owes a person the two path lists — and every path in them is a control,
// because a path a person can see and cannot take is a path they retype.

import { Nothing, RefusalCard } from "../../../primitives/index.js";
import type { ConsoleBridge } from "../../../bridge/index.js";
import {
  useEnumeratedPathAction,
  type EnumeratedPathAction,
} from "../controls/enumerated-path-action.js";
import type { RunControlRecord } from "../controls/run-control-surface.js";
import { DurableInterventionRow } from "./DurableInterventionRow.js";
import { InterventionRow } from "./InterventionRow.js";
import {
  useDurableInterventionHistory,
  type DurableInterventionHistoryReading,
} from "./durable-intervention-history.js";

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
  //
  // AND THE ANSWER IS KEYED, WHICH IS WHAT MAKES ONE HOLDER HONEST. The action is
  // handed down whole and each row asks it about ITSELF, so a failed copy draws its
  // refusal under the disclosure that offered the path and under no other. Passing
  // the bare refusal to every row drew the same failure beneath every rollback's
  // paths, which told a person that actions they never took had failed.
  const pathAction = useEnumeratedPathAction(props.bridge);
  const durableHistory = useDurableInterventionHistory(props.bridge, props.runId);
  const dispatchedRows = props.records.filter((record) => record.runId === props.runId);
  return (
    <div className="meridian-interventions">
      <DurableInterventions reading={durableHistory} />
      <DispatchedInterventions rows={dispatchedRows} pathAction={pathAction} />
    </div>
  );
}

/**
 * The daemon's own rows for this run: every intervention, whoever raised it.
 *
 * Three absences and never one. Nobody has answered yet, the read was put and the port
 * refused it, and the daemon answered naming none are three different facts, and this
 * surface renders each in its own words rather than letting a skeleton stand in for a
 * refusal.
 */
function DurableInterventions(props: {
  readonly reading: DurableInterventionHistoryReading;
}): React.JSX.Element {
  const { reading } = props;
  if (reading === undefined) {
    return (
      <Nothing
        kind="not-loaded"
        placement="inline"
        title="Reading the run's intervention record."
      />
    );
  }
  if (reading.kind === "unreadable") {
    return <RefusalCard code={reading.refusal.code} detail={reading.refusal.detail} />;
  }
  const { outcome } = reading;
  if (outcome.status !== "served") {
    return <RefusalCard code={outcome.code} detail={outcome.detail} />;
  }
  if (outcome.value.records.length === 0) {
    return (
      <Nothing
        kind="empty"
        placement="inline"
        title="No intervention has been raised against this run."
        detail="The daemon's durable record answered and named none. Every intervention is recorded, including the attempts that fail, so an empty record means none was ever raised."
      />
    );
  }
  return (
    <ol className="meridian-interventions__rows" aria-label="The run's intervention record">
      {outcome.value.records.map((record) => (
        <DurableInterventionRow key={record.interventionId} record={record} />
      ))}
    </ol>
  );
}

/**
 * What THIS window dispatched, and how each call settled.
 *
 * Kept beside the durable rows rather than folded into them: this half carries the
 * settlement the durable read does not — the rollback result union and, on the three
 * dispositions that carry them, both never-silent file enumerations.
 */
function DispatchedInterventions(props: {
  readonly rows: readonly RunControlRecord[];
  readonly pathAction: EnumeratedPathAction;
}): React.JSX.Element | null {
  if (props.rows.length === 0) {
    return null;
  }
  return (
    <ol className="meridian-interventions__rows" aria-label="Interventions this window dispatched">
      {props.rows.map((record) => (
        <InterventionRow key={record.recordId} record={record} pathAction={props.pathAction} />
      ))}
    </ol>
  );
}
