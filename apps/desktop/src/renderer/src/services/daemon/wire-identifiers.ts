// The console's one reading of a wire identifier. The store holds ids as plain strings while
// requests take branded ids, so the registered schema is read here once instead of being cast per
// call site. A contracts `*Schema` is importable only in `services/`, so features consume these
// `read*` functions, which return the value or `undefined`. They mint no refusal: whether an
// unreadable id is a refusal, a dropped row or a skipped chip is the caller's decision.

import {
  QueueItemIdSchema,
  RunIdSchema,
  RunStateSchema,
  SessionIdSchema,
  WorkspaceIdSchema,
  type QueueItemId,
  type RunId,
  type RunState,
  type SessionId,
  type WorkspaceId,
} from "@ai-sidekicks/contracts";

/** The session identifier the wire admits, or `undefined` where it admits none. */
export function readSessionId(value: string): SessionId | undefined {
  const parsed = SessionIdSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** The run identifier the wire admits, or `undefined` where it admits none. */
export function readRunId(value: string): RunId | undefined {
  const parsed = RunIdSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** The queue-item identifier the wire admits, or `undefined` where it admits none. */
export function readQueueItemId(value: string): QueueItemId | undefined {
  const parsed = QueueItemIdSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The workspace identifier the wire admits, or `undefined` where it admits none.
 *
 * @consumedBy preparing an execution root on the session's own workspace
 */
export function readWorkspaceId(value: string): WorkspaceId | undefined {
  const parsed = WorkspaceIdSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The run state the wire admits, or `undefined` for a word this build does not know, such as a
 * state from a newer daemon. It lives here because a view branching on the daemon's word needs the
 * closed union.
 */
export function readRunState(value: string): RunState | undefined {
  const parsed = RunStateSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The states in which a run is still the daemon's to move. Written as a positive set rather than
 * as the complement of the terminals, so a state added upstream lands outside it instead of being
 * assumed finished.
 */
const LIVE_RUN_STATES: ReadonlySet<RunState> = new Set<RunState>([
  "queued",
  "starting",
  "running",
  "waiting_for_approval",
  "waiting_for_input",
  "paused",
]);

/**
 * Whether a run is still moving, by the state the daemon last reported. It decides what a view
 * offers or says, never whether the daemon admits an act: eligibility is the daemon's and reaches
 * the view as a typed refusal.
 */
export function isLiveRunState(state: RunState): boolean {
  return LIVE_RUN_STATES.has(state);
}
