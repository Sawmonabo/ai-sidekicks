// The run-record plane: the two durable reads a run's own surfaces need and the
// corpus registers as columns without a method to fetch them.
//
// One plane of `GROWTH_OPERATIONS`, composed into it by `index.ts`.

import type { GrowthOperationEntry, GrowthOperationId } from "../growth-port/growth-entry.js";
import { op } from "./operation-entry.js";

/**
 * The ids this plane carries, DERIVED from the id union rather than listed again.
 *
 * `Extract` against the plane's own name pattern, on every sibling plane's rule: a row
 * this plane owns and forgot fails here, and a key that is not an operation id fails
 * here too.
 */
type RunRecordOperationId = Extract<GrowthOperationId, `runRecord${string}`>;

/** The run-record rows. */
export const RUN_RECORD_GROWTH_OPERATIONS: Readonly<
  Record<RunRecordOperationId, GrowthOperationEntry>
> = {
  runRecordInterventionHistoryRead: op(
    "runRecordInterventionHistoryRead",
    "intervention-history-read",
    "method",
  ),
  runRecordQueueRunBindingRead: op(
    "runRecordQueueRunBindingRead",
    "queue-item-run-binding",
    "method",
  ),
};

/**
 * What each of this plane's operations is, in a sentence.
 *
 * A second declaration rather than a member of the row beside it — `index.ts` states
 * the rule, which is `growth-slate-consumers.ts`'s: the split is by CONSUMER, and no
 * running console reads a sentence. The `Record` is over this plane's own id set, so a
 * row with no sentence and a sentence under an unknown id are both compile errors.
 */
export const RUN_RECORD_GROWTH_OPERATION_SUMMARIES: Readonly<Record<RunRecordOperationId, string>> =
  {
    runRecordInterventionHistoryRead:
      "read every durable intervention raised against one run — its origin discriminator, the admitting principal on the participant arm, the queue item it admitted, and the decrypted directive where the authoring participant's key still opens it",
    runRecordQueueRunBindingRead:
      "read the run each queued item in a session is bound to, the projection of `queue_items.target_run_id` that the registered `QueueItemSummary` carries no member for",
  };
