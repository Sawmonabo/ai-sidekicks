// One intervention, as the run's history shows it.
//
// Split from `InterventionHistory.tsx`, which owns the list — what is in it, in
// what order — while this owns one entry and the two readings it carries: how the
// intervention settled, and what it actually said.
//
// THE TERMINAL AND THE BODY TRAVEL WITH THE ROW because neither is read anywhere
// else, and a settlement rendered apart from the directive it settled is two halves
// of one record a reader has to reassemble.

import { Chip, WireFigure } from "../../primitives/index.js";
import { readAppliedRollback, readDegradedRollback } from "./rollback-result.js";
import { RollbackDisclosure } from "./RollbackDisclosure.js";
import type { RunControlRecord } from "./run-control-surface.js";

/** One intervention, in the daemon's own figures. */
export function InterventionRow(props: { readonly record: RunControlRecord }): React.JSX.Element {
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
