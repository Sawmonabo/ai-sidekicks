// Who directed this run, what they asked for, and whether it landed — including
// the attempts that did not.
//
// `Spec-023 §Console Design (Meridian)` §7.5 asks for every intervention in order
// with its terminal state from the six-member `InterventionState`, the `origin`
// discriminator, the admitting principal on the participant arm, the rejection
// reason verbatim on a `rejected` row, and the disposition on a `degraded` rollback.
//
// WHAT THE WIRE SUPPLIES AND WHAT IT DOES NOT. The rows this surface can honestly
// render come from `InterventionRequestResponse`, which carries the intervention
// id, the type, the state, the advanced run version, the rejection reason, and the
// rollback result. `interventions.origin` and `interventions.admitting_principal_id`
// are DURABLE columns with no registered read anywhere in the corpus — no method,
// no event payload — so this surface renders neither and says so, rather than
// inferring an origin from an absent field. §7.5's own Never list is explicit that
// the discriminator is resolved and never inferred, and the honest form of that
// here is an absence with its reason.
//
// FAILED ATTEMPTS ARE PART OF THE RECORD. A refused control is a row, not an
// omission: interventions require durable audit records even when they fail, and a
// history that showed only what worked would be the wrong shape of the same claim.
//
// A DEGRADED SETTLEMENT IS NEVER A SUCCESS. The rollback arm renders through
// `rollback-result.ts`'s exhaustive reading, so a degraded disposition arrives with
// its own words, its own daemon-supplied positions, and — on the three arms that
// carry them — both never-silent file enumerations.

import { Chip, Nothing, WireFigure } from "../../primitives/index.js";
import { readAppliedRollback, readDegradedRollback } from "./rollback-result.js";
import { RollbackDisclosure } from "./RollbackDisclosure.js";
import type { RunControlRecord } from "./run-control-surface.js";

export interface InterventionHistoryProps {
  /** Newest last, matching the ledger's reading direction. */
  readonly records: readonly RunControlRecord[];
  /** Rows for this run alone. */
  readonly runId: string;
}

export function InterventionHistory(props: InterventionHistoryProps): React.JSX.Element {
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
        <InterventionRow key={record.recordId} record={record} />
      ))}
    </ol>
  );
}

/** One intervention, in the daemon's own figures. */
function InterventionRow(props: { readonly record: RunControlRecord }): React.JSX.Element {
  const { record } = props;
  return (
    <li className="meridian-interventions__row">
      <div className="meridian-interventions__head">
        <Chip tone="neutral" label={record.control} mono />
        <InterventionTerminal record={record} />
      </div>
      <InterventionBody record={record} />
    </li>
  );
}

/** The terminal chip: the wire's own state string, or the refusal's own code. */
function InterventionTerminal(props: { readonly record: RunControlRecord }): React.JSX.Element {
  const { outcome } = props.record;
  if (outcome.kind === "refused") {
    return <Chip tone="failure" label={outcome.refusal.code} mono />;
  }
  if (outcome.kind === "acknowledged") {
    return <Chip tone="accent" label={outcome.ack.currentState} mono />;
  }
  return <Chip tone={TERMINAL_TONES[outcome.response.state]} label={outcome.response.state} mono />;
}

/**
 * The tone each of the six intervention states takes. Total over the closed set.
 *
 * `degraded` is `attention` and not `failure`: a degraded steer is a real outcome
 * rather than an error, and colouring it as a failure would be the console
 * disagreeing with the daemon about what happened.
 */
const TERMINAL_TONES = {
  requested: "neutral",
  accepted: "neutral",
  applied: "accent",
  rejected: "failure",
  degraded: "attention",
  expired: "attention",
} as const satisfies Readonly<Record<string, "neutral" | "accent" | "attention" | "failure">>;

/** What one settlement carried, beyond its terminal. */
function InterventionBody(props: { readonly record: RunControlRecord }): React.JSX.Element | null {
  const { outcome } = props.record;
  if (outcome.kind === "refused") {
    return <p className="meridian-interventions__detail">{outcome.refusal.detail}</p>;
  }
  if (outcome.kind === "acknowledged") {
    return (
      <p className="meridian-interventions__detail">
        Run version <WireFigure value={String(outcome.ack.runVersion)} />.
      </p>
    );
  }
  const { response } = outcome;
  return (
    <>
      <p className="meridian-interventions__detail">
        <WireFigure value={response.interventionId} /> — run version{" "}
        <WireFigure value={String(response.runVersion)} />.
      </p>
      {response.rejectionReason === undefined ? null : (
        // Verbatim. `driver.capability_unsupported` arrives here as a rejection
        // reason rather than as a transport error, and the console neither
        // rewords it nor promotes it to a failure of its own.
        <p className="meridian-interventions__reason">
          <WireFigure value={response.rejectionReason} />
        </p>
      )}
      {response.interventionType === "rollback" && response.state === "applied" ? (
        <RollbackDisclosure reading={readAppliedRollback(response.result)} />
      ) : null}
      {response.interventionType === "rollback" && response.state === "degraded" ? (
        <RollbackDisclosure reading={readDegradedRollback(response.result)} />
      ) : null}
    </>
  );
}
