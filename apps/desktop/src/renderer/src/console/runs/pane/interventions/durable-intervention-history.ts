// The run's durable intervention record: when it is asked for, and what the surface
// reads while the answer is out.
//
// ITS OWN MODULE BESIDE THE LIST because the list renders and this asks. The history
// used to be a projection of what THIS WINDOW dispatched — `run-control-surface.ts`'s
// records — which is a true statement about this window and the wrong statement about
// the run: an intervention raised by another participant, or by this participant in a
// previous window, or by the system, appeared nowhere. This read is what makes the
// list the run's record.
//
// ASKED ONCE PER RUN, through the seat that exists for exactly that. The durable rows
// are appended by the daemon and no registered stream announces one, so a repeat
// re-asks a question with a standing answer; what this window itself dispatches keeps
// arriving through the surface's own records and is rendered beside these rows rather
// than folded into them.
//
// AND THE TWO HALVES ARE NEVER MERGED. A window's dispatch and the daemon's durable
// row describe the same intervention from two sides — one carries the settlement this
// window watched, the other carries the origin and the principal the daemon resolved
// — and matching them would mean matching on an id this window does not learn until
// its own call settles. So the surface renders both, says which is which, and derives
// no correspondence it cannot read.

import { useCallback } from "react";

import { useGrowthReadOnMount } from "../../../seats/index.js";
import type { ConsoleBridge, GrowthOutcome, GrowthReading } from "../../../bridge/index.js";
import type { GrowthInterventionRecord } from "../../../bridge/index.js";

/** Names this read in a refusal the call itself did not name. */
export const DURABLE_INTERVENTION_HISTORY_ORIGIN = "durable-intervention-history";

/** What the history holds for the durable rows at any moment. */
export type DurableInterventionHistoryReading =
  | GrowthReading<GrowthOutcome<{ readonly records: readonly GrowthInterventionRecord[] }>>
  | undefined;

/**
 * The durable record for one run, asked once when the row opens.
 *
 * The RUN is the subject, which is what makes it sound to re-ask exactly when the row
 * is addressed at a different run: the seat holds the answer under that key and a
 * reply for a run this surface has left publishes nowhere.
 */
export function useDurableInterventionHistory(
  bridge: ConsoleBridge,
  runId: string,
): DurableInterventionHistoryReading {
  const ask = useCallback(
    async (askedBridge: ConsoleBridge, request: { readonly runId: string }) =>
      await askedBridge.growth.runRecordInterventionHistoryRead(request),
    [],
  );
  return useGrowthReadOnMount({
    bridge,
    subject: runId,
    request: { runId },
    origin: DURABLE_INTERVENTION_HISTORY_ORIGIN,
    ask,
  });
}
