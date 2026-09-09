// The run-record plane: the durable intervention history for one run, and the queue's
// run bindings for one session.
//
// One plane of `GrowthOperationSignatures`, composed into it by `signature-table.ts`.

import type { GrowthInterventionRecord, GrowthQueueItemRunBinding } from "../wire-shapes/index.js";

export interface RunRecordGrowthSignatures {
  // Addressed by the RUN and not by the session, because that is the subject the
  // surface asking has: the history sits inside a run's own row and never sees a
  // session id. A session-wide read would hand every run row the whole session's
  // interventions to filter, which is a second copy of the daemon's own scoping.
  runRecordInterventionHistoryRead: {
    request: { readonly runId: string };
    value: { readonly records: readonly GrowthInterventionRecord[] };
  };
  // Addressed by the SESSION, because the queue is: `run.subscribeQueue` and
  // `run.queueList` are both session-scoped, so the binding projection is asked
  // exactly once beside them rather than once per row.
  runRecordQueueRunBindingRead: {
    request: { readonly sessionId: string };
    value: { readonly bindings: readonly GrowthQueueItemRunBinding[] };
  };
}
