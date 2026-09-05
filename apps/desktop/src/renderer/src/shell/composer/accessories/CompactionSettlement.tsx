// What the compaction control says after the dispatch settles.
//
// Split from `CompactionControl.tsx` because the control owns the ACT — the
// capability gate, the dispatch, the in-flight state — and this owns the SENTENCE
// that act leaves behind, which is a different thing to get right and a different
// thing to read.
//
// IT REPORTS AND NEVER INFERS. Every arm below is a settlement the driver reply
// carried; a compaction whose boundary the daemon has not confirmed is not rendered
// as one here, because the request being accepted is not the work being done.

import { InlineRefusal, WireFigure } from "../../../console/primitives/index.js";
import { type CompactionDispatchState } from "./compaction-dispatch.js";

/**
 * What the call answered, rendered wherever it was not `applied`.
 *
 * `applied` renders nothing here on purpose: the positive receipt is the ledger's
 * compaction row, and a second "done" beside the button would be the console
 * claiming a completion from an acknowledgment.
 */
export function CompactionSettlement(props: {
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
