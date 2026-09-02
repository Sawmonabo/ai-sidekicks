// The compaction control, beside the meter.
//
// THE THREE-VALUE CAPABILITY, AND WHY IT IS NOT A BOOLEAN. The design says the
// control is present only where the driver declares `context_compaction`, and that
// it is never shown disabled. A boolean collapses "the driver cannot compact" into
// "we have not read whether it can", and those want opposite renders: the first is
// an absence with nothing to say, the second is rule 8's `not-checked` — the
// question was never put. So the caller names which of the three it holds, and the
// control renders accordingly. There is deliberately no disabled arm.
//
// WHAT SETTLES THE CONTROL, AND WHAT COMPLETES THE COMPACTION. Two different
// things, and conflating them is the failure this surface is most likely to make.
// The call settles the CONTROL — in every arm, including the rejection — and the
// settlement reason renders wherever it is not `applied`. Whether the context was
// actually compacted is the `usage.context_compacted` row and nothing else, which
// is why the completed line below is driven by a boundary the ledger recorded
// rather than by the reply that came back.

import { InlineRefusal, Nothing, WireFigure } from "../../../console/primitives/index.js";
import type { ConsoleBridge } from "../../../console/bridge/index.js";
import { useCompactionDispatch, type CompactionDispatchState } from "./compaction-dispatch.js";

/**
 * What the console knows about the driver's compaction capability.
 *
 * Closed at three and declared once. `unknown` is the honest value while no read
 * answers the question — it is not a synonym for `undeclared`.
 */
export const COMPACTION_CAPABILITY_STATES = ["declared", "undeclared", "unknown"] as const;

/** One capability state. Derived from the enumeration above. */
export type CompactionCapabilityState = (typeof COMPACTION_CAPABILITY_STATES)[number];

export interface CompactionControlProps {
  readonly bridge: ConsoleBridge;
  readonly sessionId: string;
  /** The run whose binding would be compacted, or `undefined` when there is none. */
  readonly targetRunId: string | undefined;
  readonly capability: CompactionCapabilityState;
  /**
   * The newest `usage.context_compacted` position, when the session has one.
   *
   * The ONLY evidence a compaction happened. Passed in rather than read here so the
   * control cannot mistake its own reply for this fact.
   */
  readonly completedBoundarySequence: number | undefined;
}

export function CompactionControl(props: CompactionControlProps): React.JSX.Element | null {
  const dispatch = useCompactionDispatch(props.bridge, props.sessionId);

  if (props.capability === "undeclared") {
    // Absent, and silent. A driver that cannot compact has nothing to say about
    // compaction, and a line explaining its absence would be noise on every
    // composer bound to such a driver.
    return null;
  }
  if (props.capability === "unknown" || props.targetRunId === undefined) {
    return (
      <Nothing
        kind="not-checked"
        title="Whether this driver can compact has not been read."
        detail="The control appears once a driver declares the capability; until then the console does not guess either way."
      />
    );
  }

  const targetRunId = props.targetRunId;
  const isDispatching = dispatch.state.phase === "dispatching";
  return (
    <div className="meridian-compaction">
      <button
        type="button"
        className="meridian-compaction__action"
        aria-busy={isDispatching}
        onClick={() => {
          dispatch.requestCompaction(targetRunId);
        }}
      >
        {isDispatching ? "Compacting…" : "Compact"}
      </button>
      <CompactionSettlement state={dispatch.state} />
      {props.completedBoundarySequence === undefined ? null : (
        <span className="meridian-compaction__completed">
          Compacted at position <WireFigure value={String(props.completedBoundarySequence)} />
        </span>
      )}
    </div>
  );
}

/**
 * What the call answered, rendered wherever it was not `applied`.
 *
 * `applied` renders nothing here on purpose: the positive receipt is the ledger's
 * compaction row, and a second "done" beside the button would be the console
 * claiming a completion from an acknowledgment.
 */
function CompactionSettlement(props: {
  readonly state: CompactionDispatchState;
}): React.JSX.Element | null {
  const { state } = props;
  if (state.phase === "rejected") {
    return <InlineRefusal code={state.refusal.code} detail={state.refusal.detail} />;
  }
  if (state.phase !== "settled" || state.result.status === "applied") {
    return null;
  }
  return (
    <span className="meridian-compaction__settlement" role="status">
      <WireFigure value={state.result.status} />
      <WireFigure value={state.result.reason} />
    </span>
  );
}
