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
