// What the runs scenario's DURABLE run records say, as opposed to what its stream
// plays or its registered replies answer.
//
// A third file beside `runs.ts` and `runs.replies.ts` on their own seam. A beat is a
// stream frame and a reply is a registered call; these are neither — they are the
// projection of two durable columns the corpus registers and no wire returns, served
// through the growth port. Scripting them inside `runs.replies.ts` would file them
// under a `call:` that names no method, and scripting them as beats would claim the
// daemon emits an event for them, which is exactly the inference the history is
// forbidden to make.
//
// WHY THE ROWS ARE NOT THE ONES THE WINDOW DISPATCHED. The point of the durable read
// is that it carries interventions this window never sent — one raised on another
// device and one raised by the system — so the history stops being a dispatch log and
// becomes the run's record. A table that mirrored the scenario's own control presses
// would leave that difference untestable.

import { QUEUE_ITEM_ADMITTED, QUEUE_ITEM_WAITING, RUN_ID } from "./identifiers.js";
import type {
  GrowthInterventionRecord,
  GrowthQueueItemRunBinding,
} from "../../wire-shapes/index.js";

/** The intervention whose directive rests under a key this node no longer holds. */
const INTERVENTION_SHREDDED = "019b7a22-2200-7d31-8110-d1a4c1150431";
const INTERVENTION_ADMITTED_SEND = "019b7a22-2200-7d31-8120-d1a4c1150432";
const INTERVENTION_SYSTEM_CANCEL = "019b7a22-2200-7d31-8130-d1a4c1150433";
const INTERVENTION_REJECTED_ROLLBACK = "019b7a22-2200-7d31-8140-d1a4c1150434";

/**
 * The run's durable intervention record, newest last.
 *
 * Four rows and four different things to render: a participant-raised steer whose body
 * is gone, a participant-raised steer that admitted a queue item, a system-raised
 * cancel, and a rejected rollback carrying its reason verbatim. Between them both
 * origin labels, both directive arms, and both optional members appear, so a surface
 * that dropped one has a row that renders wrongly rather than a case nothing
 * exercises.
 */
export const RUNS_INTERVENTION_RECORDS: readonly GrowthInterventionRecord[] = [
  {
    interventionId: INTERVENTION_SHREDDED,
    runId: RUN_ID,
    interventionKind: "steer",
    state: "applied",
    origin: "participant",
    // The key is gone, so the audit record survives its body. The console renders the
    // record and says the text cannot be read — never an empty directive, which would
    // claim the participant said nothing.
    directive: { availability: "unavailable" },
    requestedAt: "2026-01-01T15:58:12.000Z",
  },
  {
    interventionId: INTERVENTION_ADMITTED_SEND,
    runId: RUN_ID,
    interventionKind: "steer",
    state: "applied",
    origin: "participant",
    directive: {
      availability: "available",
      text: "Prefer the smaller diff and leave the migration for a second pass.",
    },
    // The row-anchored linkage: this steer is what admitted the queue item that the
    // queue list shows as `admitted`, so a drained replacement resolves one row.
    admittedQueueItemId: QUEUE_ITEM_ADMITTED,
    requestedAt: "2026-01-01T15:59:04.000Z",
  },
  {
    interventionId: INTERVENTION_SYSTEM_CANCEL,
    runId: RUN_ID,
    interventionKind: "cancel",
    state: "applied",
    // The in-process orchestration entrypoint, resolved by the daemon and never
    // client-supplied.
    origin: "system",
    directive: { availability: "unavailable" },
    requestedAt: "2026-01-01T15:59:41.000Z",
  },
  {
    interventionId: INTERVENTION_REJECTED_ROLLBACK,
    runId: RUN_ID,
    interventionKind: "rollback",
    state: "rejected",
    origin: "participant",
    directive: { availability: "unavailable" },
    rejectionReason: "run.invalid_transition",
    requestedAt: "2026-01-01T16:00:02.000Z",
  },
];

/**
 * Which queued rows this session's queue is bound to a run by.
 *
 * Two of the three rows the queue list answers with, and the third deliberately has no
 * entry: `queue_items.target_run_id` is nullable, so an unbound row is a row the read
 * names nothing about rather than one it names a null for.
 */
export const RUNS_QUEUE_RUN_BINDINGS: readonly GrowthQueueItemRunBinding[] = [
  { queueItemId: QUEUE_ITEM_ADMITTED, targetRunId: RUN_ID },
  { queueItemId: QUEUE_ITEM_WAITING, targetRunId: RUN_ID },
];
