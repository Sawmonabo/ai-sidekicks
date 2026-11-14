// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The payloads of a session's own events: its creation, its lifecycle moves, its renames, its marks, its advisor, its output style and its provider's status.

import type { AgentDefinitionId } from "../agent/definition.js";
import type { AgentSubscribeEntry } from "../agent/methods.js";
import type { SourceEpoch, SourcePosition } from "../event/envelope.js";
import type { WireInstant } from "../internal/wire-scalars.js";
import type { Place } from "../place.js";
import type { ProviderId } from "../provider/id.js";
import type { RunId } from "../run/id.js";
import type { EventCursor, SessionId, UserId } from "./id.js";
import type { SessionShape, SessionState } from "./methods.js";

/**
 * The state an unarchived session returns to: `active`, or `provisioning` for one archived before
 * its create finished, which the create's finish then takes on to `active`.
 */
export type SessionReactivatedState = "active" | "provisioning";
/**
 * Who a rename came from: the person (`user`), the provider renaming its own conversation
 * (`provider`), or the daemon's naming pass after the first exchange (`auto`), which writes only
 * while the session is unnamed, so a name the person typed always wins.
 */
export type SessionRenameOrigin = "user" | "provider" | "auto";

/**
 * The session a fork was taken from, and the message it was taken at.
 */
export interface SessionCreatedParent {
  /**
   * The session forked from.
   */
  sessionId: SessionId;
  /**
   * The message the fork was taken at.
   */
  anchorCursor: EventCursor;
}
/**
 * A session's birth, bringing in its lead as `mainAgent`. `parent` is present exactly on a fork,
 * `scratchForDefinitionId` names the saved definition a scratch session tries, and `place` is
 * where the session runs for its whole life.
 */
export interface SessionCreatedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The session's shape.
   */
  shape: SessionShape;
  /**
   * The session's lead.
   */
  mainAgent: AgentSubscribeEntry;
  /**
   * The session forked from, on a fork.
   */
  parent?: SessionCreatedParent;
  /**
   * The saved definition a scratch session tries.
   */
  scratchForDefinitionId?: AgentDefinitionId;
  /**
   * The person who created it.
   */
  actor?: UserId;
  /**
   * Where it runs, written here once and never changed; absent on macOS and Linux.
   */
  place?: Place;
}
/**
 * The payload of a lifecycle move (`session.activated`, `session.archived`, `session.closed`),
 * naming the state the session left and the one it is in. `actor` is the person who acted, absent
 * when the daemon moved it.
 */
export interface SessionLifecycleChangePayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The state it left, where it had one.
   */
  previousState?: SessionState;
  /**
   * The state it is in.
   */
  newState: SessionState;
  /**
   * The person who acted, absent when the daemon moved it.
   */
  actor?: UserId;
}
/**
 * The `session.reactivated` payload: an archived session back on the live list, naming the state
 * it left and the one it returns to. `actor` is the person who acted, absent when the daemon
 * moved it.
 */
export interface SessionReactivatedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The state it left, where it had one.
   */
  previousState?: SessionState;
  /**
   * The state it returns to.
   */
  state: SessionReactivatedState;
  /**
   * The person who acted, absent when the daemon moved it.
   */
  actor?: UserId;
}
/**
 * The `session.renamed` payload: the new name, `null` when the name was cleared, the name it
 * replaced where there was one, and who renamed it. A rename to the current name writes no event.
 */
export interface SessionRenamedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The new name, or `null` when it was cleared.
   */
  name: string | null;
  /**
   * The name it replaced, where there was one.
   */
  previousName?: string;
  /**
   * Who renamed it.
   */
  origin: SessionRenameOrigin;
  /**
   * The person who renamed it.
   */
  actor?: UserId;
}
/**
 * The payload of a session mark set or cleared (`session.pinned`, `session.unpinned`,
 * `session.muted`, `session.unmuted`) with the time it happened. Pinned rows sit in the order they
 * were pinned, and a mute stands until it is cleared: both are rebuilt from these events.
 */
export interface SessionMarkChangePayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * When it happened.
   */
  at: WireInstant;
}
/**
 * The `session.advisor.changed` payload: the session's own advisor, changed by the provider's own
 * advisor command in that session. `advisorModel` is the session's own setting, `null` when the
 * advisor is off; `attachedAdvisorModel` is the advisor the provider says it attaches after the
 * change, `null` when none attaches, absent where the build does not report it.
 */
export interface SessionAdvisorChangedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The session's own advisor setting, or `null` when the advisor is off.
   */
  advisorModel: string | null;
  /**
   * The advisor the provider attaches, `null` when none, absent where the build does not say.
   */
  attachedAdvisorModel?: string | null;
  /**
   * When it happened.
   */
  at: WireInstant;
}
/**
 * The `session.outputStyle.changed` payload: the session's own output style, changed by the
 * provider's own output-style command in that session, with the time it happened.
 */
export interface SessionOutputStyleChangedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The output style.
   */
  outputStyle: string;
  /**
   * When it happened.
   */
  at: WireInstant;
}
/**
 * The `session.providerStatus.reported` payload: a coarse status the provider reported for its
 * session, normalized, with display text where it sent some. It records what the provider said and
 * never moves the session's own state. It takes the epoch stamp: `sourceEpoch` and
 * `sourcePosition` come together, and only on a payload naming its run.
 */
export interface SessionProviderStatusReportedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run, where the status names one.
   */
  runId?: RunId;
  /**
   * The provider.
   */
  provider: ProviderId;
  /**
   * The status, normalized.
   */
  status: string;
  /**
   * The provider's display text, where it sent some.
   */
  detail?: string;
  /**
   * The execution epoch a late row is attributed to; comes with `sourcePosition` and `runId`.
   */
  sourceEpoch?: SourceEpoch;
  /**
   * The run position the row occupies within its epoch; comes with `sourceEpoch`.
   */
  sourcePosition?: SourcePosition;
}

export {
  validateSessionAdvisorChangedPayload,
  validateSessionCreatedParent,
  validateSessionCreatedPayload,
  validateSessionLifecycleChangePayload,
  validateSessionMarkChangePayload,
  validateSessionOutputStyleChangedPayload,
  validateSessionProviderStatusReportedPayload,
  validateSessionReactivatedPayload,
  validateSessionReactivatedState,
  validateSessionRenameOrigin,
  validateSessionRenamedPayload,
} from "../checks/session/events.js";
