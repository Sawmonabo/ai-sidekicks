# Persistence Payload Contracts

Part of [API Payload Contracts](./api-payload-contracts.md), which holds the shared types, the error envelope and the conventions every shape here uses.

## Plan-012 — Persistence And Recovery

```ts
// DaemonRecoveryStatus — the `recovery` field on `DaemonStatusReadResult` (local-ipc-payloads.md §Plan-005), which
// Settings › Runtime and `sidekicks daemon status` already read. There is no recovery method of its own.
// `overall` is `degraded` while any session's history is damaged; only `rebuilding` (the restart's pass)
// and `blocked` (the store is unavailable) refuse writes for the whole service.
interface DaemonRecoveryStatus {
  overall: "healthy" | "rebuilding" | "degraded" | "blocked";
  // The sessions that are not healthy, each damaged session among them.
  sessions: Array<{
    sessionId: SessionId;
    // degraded: open at its last good point, read-only; damaged: no event of it can be read
    state: "rebuilding" | "degraded" | "damaged" | "blocked";
    lastAppliedSequence?: number; // on degraded, the last good point's sequence
    lastAppliedAt?: string; // on degraded, when that event happened: the `<time>` of the conversation's line
    damagedFromSequence?: number; // on degraded, the first event that cannot be read
    failureCategory?: RunFailureCategory;
    recoveryCondition?: RecoveryCondition; // named type in provider-driver-payloads.md §Plan-003
    // Per-run identities behind a blocked/degraded session entry: names which
    // runs need reconciliation in a multi-run session — a Plan-012 T12.5 divergence halt or a
    // failed resume each land one entry. Absent when no run-level recovery condition exists. Entry contract: a divergence-halt entry carries no
    // failureCategory (the run did not fail), and there is no failure to drill into; a
    // failed-resume entry carries failureCategory REQUIRED.
    haltedRuns?: Array<{
      runId: RunId;
      recoveryCondition: RecoveryCondition;
      failureCategory?: RunFailureCategory; // REQUIRED on a failed-resume entry; absent on a divergence halt
    }>;
  }>;
}

// session.recoveryContinue (`Continue from here`) and session.recoveryDelete (`Delete session`):
// both take a damaged session and answer `{}`; each is refused `session.recovery_refused` otherwise.
interface SessionTargetRequest {
  sessionId: SessionId;
}

// recovery.damaged_events_skipped — appended by `Continue from here` at the log's next sequence;
// every read and rebuild of the session skips the range from then on, and the rows stay stored.
interface RecoveryDamagedEventsSkippedPayload {
  sessionId: SessionId;
  fromSequence: number;
  toSequence: number; // at least fromSequence
}

// EventsReadAfterSequence
interface EventsReadAfterSequenceRequest {
  sessionId: SessionId;
  afterSequence: number;
  limit?: number;
  eventTypes?: string[]; // only events of these types; every type when absent
}
interface EventsReadAfterSequenceResponse {
  events: EventEnvelope[];
  nextSequence: number;
  hasMore: boolean;
}

// ProjectionRebuild (idempotent operation)
interface ProjectionRebuildRequest {
  sessionId: SessionId;
  force?: boolean; // rebuild even if projections appear current
}
interface ProjectionRebuildResponse {
  sessionId: SessionId;
  rebuiltProjections: string[];
  asOfSequence: number;
  eventsApplied: number; // the events the rebuild read; recovery.succeeded sums them
}

// RuntimeBindingRead
interface RuntimeBindingReadRequest {
  runId: RunId;
}
interface RuntimeBindingReadResponse {
  runId: RunId;
  driverName: string;
  contractVersion: string;
  resumeHandle?: string;
  runtimeMetadata: Record<string, unknown>;
}

// ---- The file checkpoint store, and what undo reads ----
// The daemon copies aside every file the agent or one of its children is about to edit — Write, Edit,
// MultiEdit and NotebookEdit on Claude Code, `apply_patch` on Codex — at every prompt that starts a turn,
// from its own pre-tool hook, the same hook that holds a run for Pause: one mechanism, not a second
// interception path. What a shell command writes is inside the same store on both providers: around every
// command an agent or a child runs, the daemon captures the working folder before the command starts,
// holding the start until the capture is written, and again when it ends, holding nothing; every path
// that differs between the two captures enters the store as an ordinary copy under the checkpoint of the
// prompt that started the turn, and a file the command created is recorded as new and removed on undo. A
// capture is a git tree written from a per-session index into the session's own capture folder, never
// into the person's `.git`. The copies are held WITH THE SESSION and OUTSIDE THE CHECKOUT, so they never
// appear in a diff and survive a working-folder move; they survive a resume and a restart, and every
// checkpoint is kept for the session's life, removed only by an undo or by deleting the session or its
// data.
//
// Undo is two moments: a DRY RUN the person reads (`session.restorePreview`), then the restore itself
// (`session.restore`). Both name the session, a `target` that is one of the person's messages by its
// cursor or a snapshot by its id, and a `scope` of `conversation-and-files`, `conversation` or `files`; the
// restore's request adds its idempotency key, the include line and an edit's `resend`, and its result is
// run-control-payloads.md §Plan-002's undo result. The conversation half of a restore is the provider's OWN rewind verb; the file
// half is always this checkpointer.

// Why a file would be skipped, each shown with its reason in the count's hover title.
type SessionRestoreSkipReason =
  | "symbolic_link"
  | "hard_link"
  | "not_a_regular_file"
  | "directory_moved"
  | "too_large" // a file over 10 MiB that a command changed, on a volume that cannot clone it
  | "branch_moved_by_command"; // changed by a command that moved the branch (a commit, a checkout, a reset, a pull); putting it back would turn the branch's commits into uncommitted reversals

// What an undo would do; changes nothing.
interface SessionRestorePreviewRequest {
  sessionId: SessionId;
  target: SessionRestoreTarget; // run-control-payloads.md §Plan-002
  scope: SessionRestoreScope;
}
interface SessionRestorePreviewResponse {
  // The files that would be put back, and how many lines across them — the two figures the question
  // states before anything is written.
  fileCount: number;
  lineCount: number;
  // What would be skipped, each with its reason. The count is stated and each entry is readable, because
  // a skip the person cannot inspect is a silent partial restore.
  skipped: Array<{ path: string; reason: SessionRestoreSkipReason }>;
  // The agents started after the point, which the question names before it acts: on Claude Code the
  // conversation cut ends them and they cannot be resumed, on Codex the daemon stops each by id and they
  // resume. Zero means the question asks nothing extra.
  affectedChildCount: number;
  // The commands still running after the point, which the undo stops.
  runningCommands: number;
  // The data of the two lines the count's hover title carries whenever a command ran after the point:
  // the ignored folders an ordinary undo never puts back, by name, and whether a command ran at all.
  ignoredFolders: string[];
  commandsRanAfterPoint: boolean;
  // The commands after the point that ran uncovered, because their capture failed or the service did
  // not acknowledge `starting` in time, by their command text; the dry run names each one `ran while
  // the service could not capture it`. Empty when every command was captured.
  uncoveredCommands: string[];
  // Paths another session working in the same folder also changed since the point, left as they are
  // unless the restore includes them.
  alsoChangedBy: Array<{ sessionId: SessionId; paths: string[] }>;
}
```

The dry run and the undo are `session.restorePreview` and `session.restore`, session verbs; the restore's request and result are [§Plan-002 — Queue Steer Pause Resume](./run-control-payloads.md#plan-002--queue-steer-pause-resume)'s undo contract, and `session.restorePreview` takes `SessionRestorePreviewRequest` above, answers with `SessionRestorePreviewResponse` and changes nothing. What is fixed here is the store — one hook for edits, a capture on each side of every command, three scopes addressed by a message or a snapshot — and a preview the person reads before anything is written.
