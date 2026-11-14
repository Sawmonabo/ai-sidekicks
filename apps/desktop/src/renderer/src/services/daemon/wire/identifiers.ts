// The app's one reading of a wire identifier. The store holds ids as plain strings while
// requests take branded ids, so the generated check is run here once instead of a cast per call
// site. A generated contracts check is importable only in `services/`, so features consume these
// `read*` functions, which return the value or `undefined`. They mint no refusal: whether an
// unreadable id is a refusal, a dropped row or a skipped chip is the caller's decision.
//
// Where a held id meets a request, `heldIdAsWireId` widens it instead: the client helper's addon
// checks the whole request against its contract before it leaves, so a malformed id is refused
// there.

import { validateRunId, type RunId } from "@ai-sidekicks/contracts/run/id";
import { validateRunState, type RunState } from "@ai-sidekicks/contracts/run/state";
import { validateSessionId, type SessionId } from "@ai-sidekicks/contracts/session/id";
import { validateWorkspaceId, type WorkspaceId } from "@ai-sidekicks/contracts/repo/mount";

/** The session identifier the wire admits, or `undefined` where it admits none. */
export function readSessionId(value: string): SessionId | undefined {
  return validateSessionId(value) ? value : undefined;
}

/** The run identifier the wire admits, or `undefined` where it admits none. */
export function readRunId(value: string): RunId | undefined {
  return validateRunId(value) ? value : undefined;
}

/**
 * The workspace identifier the wire admits, or `undefined` where it admits none.
 *
 * @consumedBy preparing an execution root on the session's own workspace
 */
export function readWorkspaceId(value: string): WorkspaceId | undefined {
  return validateWorkspaceId(value) ? value : undefined;
}

/**
 * The run state the wire admits, or `undefined` for a word this build does not know, such as a
 * state from a newer daemon. It lives here because a view branching on the daemon's word needs the
 * closed union.
 */
export function readRunState(value: string): RunState | undefined {
  return validateRunState(value) ? value : undefined;
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
  "waitingForApproval",
  "waitingForInput",
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
// meets a request. The addon checks the whole request against the contract that owns the brand
// before it leaves, so a malformed id is refused as `request-unsendable`. Branding a row's id for a callback is deliberately not served, because nothing
// checks it.

/**
 * Widens one held id string to the branded id a request member declares. The brand is inferred
 * from the member being filled, so a held id offered where a different id is wanted still fails to
 * compile.
 */
export function heldIdAsWireId<TWireId extends string>(heldId: string): TWireId {
  return heldId as TWireId;
}
