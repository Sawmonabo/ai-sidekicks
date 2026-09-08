// One intervention as the DAEMON's record holds it, beside the rows this window
// dispatched.
//
// Its own component rather than an arm inside `InterventionRow.tsx`, because the two
// rows answer different questions from different sources: that one renders a call this
// window made and the settlement it watched, and this one renders a durable row the
// daemon resolved — with an origin, an admitting principal, a queue-item linkage, and
// a directive body that may no longer be readable at all. Folding them would mean one
// component branching on which half of the record it was handed.
//
// NOTHING HERE IS INFERRED. The origin is the arm the daemon sent; the principal is
// read off that arm and never off an absent field; the rejection reason renders
// verbatim; and a directive whose key has been shredded says so rather than rendering
// an empty line. `Spec-023 §Rules every console surface obeys` makes the projection
// fail closed, and every member below is either present on the wire or absent from the
// row.

import { Chip, WireFigure } from "../../../primitives/index.js";
import type { GrowthInterventionRecord } from "../../../bridge/index.js";

/**
 * The tone each of the six intervention states takes. Total over the closed set.
 *
 * The same table `InterventionTerminal.tsx` applies to a dispatched row, restated for
 * a wire member typed as the contract's `InterventionState` string rather than as the
 * record union that file narrows — one lookup with a fail-closed default, so a state
 * the daemon sends that this build does not know renders as an explicit unrecognized
 * chip instead of borrowing a tone.
 */
const DURABLE_STATE_TONES: Readonly<
  Record<string, "neutral" | "accent" | "attention" | "failure">
> = {
  requested: "neutral",
  accepted: "neutral",
  applied: "accent",
  rejected: "failure",
  degraded: "attention",
  expired: "attention",
};

/** One durable intervention, in the daemon's own figures. */
export function DurableInterventionRow(props: {
  readonly record: GrowthInterventionRecord;
}): React.JSX.Element {
  const { record } = props;
  const stateTone = DURABLE_STATE_TONES[record.state];
  return (
    <li className="meridian-interventions__row">
      <div className="meridian-interventions__head">
        <Chip tone="neutral" label={record.interventionKind} mono />
        {stateTone === undefined ? (
          // A state this build does not know is named as one, never toned as though it
          // were understood.
          <Chip tone="attention" label={`unrecognized state ${record.state}`} mono />
        ) : (
          <Chip tone={stateTone} label={record.state} mono />
        )}
        <Chip tone="neutral" label={record.origin.kind} mono />
      </div>
      <p className="meridian-interventions__detail">
        <WireFigure value={record.interventionId} /> — raised{" "}
        <WireFigure value={record.requestedAt} />
        {record.origin.kind === "participant" ? (
          <>
            {" by "}
            <WireFigure value={record.origin.admittingPrincipalId} />
          </>
        ) : null}
        .
      </p>
      {record.admittedQueueItemId === undefined ? null : (
        // The row-anchored linkage, so a drained replacement resolves one admitting
        // row rather than a scan of the history.
        <p className="meridian-interventions__detail">
          Admitted queue item <WireFigure value={record.admittedQueueItemId} />.
        </p>
      )}
      <InterventionDirective record={record} />
      {record.rejectionReason === undefined ? null : (
        <p className="meridian-interventions__reason">
          <WireFigure value={record.rejectionReason} />
        </p>
      )}
    </li>
  );
}

/**
 * What the participant directed, where the console may still read it.
 *
 * The body-unavailable arm is a SENTENCE and not an empty line: a steer directive and
 * a replacement-send body rest encrypted under the authoring participant's key, so a
 * row whose key has been shredded is a complete audit record with an unreadable
 * directive — which is a different fact from an intervention that carried no text.
 */
function InterventionDirective(props: {
  readonly record: GrowthInterventionRecord;
}): React.JSX.Element {
  const { directive } = props.record;
  return directive.availability === "available" ? (
    <p className="meridian-interventions__directive">{directive.text}</p>
  ) : (
    <p className="meridian-interventions__detail">
      The directive rests encrypted under the authoring participant&apos;s key, which this node no
      longer holds. The audit record stands; its text cannot be read.
    </p>
  );
}
