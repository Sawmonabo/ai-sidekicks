// What one settlement carried, beyond its terminal.
//
// Its own module because a `.tsx` declares one component, and a sibling of
// `InterventionRow.tsx` for the reason that file's header gives: the body travels
// with the row because it is read nowhere else, and a settlement rendered apart from
// the directive it settled is two halves of one record a reader has to reassemble.

import { WireFigure } from "../../../primitives/index.js";
import type { ConsoleRefusal } from "../../../core/index.js";
import { readAppliedRollback, readDegradedRollback } from "../controls/rollback-result.js";
import { RollbackDisclosure } from "../controls/RollbackDisclosure.js";
import type { RunControlRecord } from "../controls/run-control-surface.js";

/** What one settlement carried, beyond its terminal. */
export function InterventionBody(props: {
  readonly record: RunControlRecord;
  /** What the history offers on one enumerated path, threaded to the file half. */
  readonly onPathAction: ((path: string) => void) | undefined;
  readonly pathActionRefusal: ConsoleRefusal | undefined;
}): React.JSX.Element | null {
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
        <RollbackDisclosure
          reading={readAppliedRollback(response.result)}
          result={response.result}
          onPathAction={props.onPathAction}
          pathActionRefusal={props.pathActionRefusal}
        />
      ) : null}
      {response.interventionType === "rollback" && response.state === "degraded" ? (
        <RollbackDisclosure
          reading={readDegradedRollback(response.result)}
          result={response.result}
          onPathAction={props.onPathAction}
          pathActionRefusal={props.pathActionRefusal}
        />
      ) : null}
    </>
  );
}
