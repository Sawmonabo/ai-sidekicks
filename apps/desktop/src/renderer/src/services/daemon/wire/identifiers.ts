// The app's one reading of a wire identifier. The store holds ids as plain strings while
// requests take branded ids, so the registered schema is read here once instead of being cast per
// call site. A contracts `*Schema` is importable only in `services/`, so features consume these
// `read*` functions, which return the value or `undefined`. They mint no refusal: whether an
// unreadable id is a refusal, a dropped row or a skipped chip is the caller's decision.
//
// Where a held id meets a request, `heldIdAsWireId` widens it instead: `callDaemon` parses the
// whole request through the schema that owns the brand, so a malformed id is refused there.

import { RunIdSchema, type RunId } from "@ai-sidekicks/contracts/provider/driver/intervention";
import { RunStateSchema, type RunState } from "@ai-sidekicks/contracts/run/state";
import { SessionIdSchema, type SessionId } from "@ai-sidekicks/contracts/session/id";
import { WorkspaceIdSchema, type WorkspaceId } from "@ai-sidekicks/contracts/repo/mount";

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
  "pausing",
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

// Widens an app-held id string to the branded id a registered request declares. Held ids are
// plain strings (route params, scenario data, rendered rows), so a caller widens where a held id
// meets a request. `callDaemon` parses the whole request through the contracts schema that owns the
// brand, so a malformed id is refused as `request-unsendable`; a cast anywhere else would carry no
// such check. Branding a row's id for a callback is deliberately not served, because nothing
// checks it.

/**
 * Widens one held id string to the branded id a request member declares. The brand is inferred
 * from the member being filled, so a held id offered where a different id is wanted still fails to
 * compile.
 */
export function heldIdAsWireId<TWireId extends string>(heldId: string): TWireId {
  return heldId as TWireId;
}
