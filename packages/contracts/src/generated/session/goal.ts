// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// A goal inside a session: the condition one agent works toward, the two methods that set and clear it, and the two events that record each change.

import type { AgentId } from "../agent/definition.js";
import type { SessionAcknowledgment } from "./controls/methods.js";
import type { SessionId } from "./id.js";

/**
 * Where a goal stands. `complete` and `impossible` are final; a goal's last status is what its row
 * draws. `impossible` comes only from a provider whose judge can rule a goal out, carrying the
 * judge's reason. Clearing is the event `session.goal.cleared`, never a status.
 */
export type SessionGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usageLimited"
  | "budgetLimited"
  | "complete"
  | "impossible";

/**
 * A goal's condition, as the person wrote it. `text` has no length cap of the app's own; it is
 * not blank and free of NUL, checked as written and never trimmed. Clearing is its own operation,
 * so an update with empty text is refused rather than read as a clear.
 */
export interface SessionGoal {
  /**
   * The condition.
   */
  text: string;
}
/**
 * Sets or replaces the goal of one agent in the session. The last write wins.
 */
export interface SessionGoalUpdateRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The agent.
   */
  agentId: AgentId;
  /**
   * The goal.
   */
  goal: SessionGoal;
}
/**
 * The accepted goal, echoed exactly as the `session.goal.updated` event carries it.
 */
export interface SessionGoalUpdateResponse {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The goal.
   */
  goal: SessionGoal;
}
/**
 * Removes one agent's goal. With no goal set it succeeds, as a provider's own clear does.
 */
export interface SessionGoalClearRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The agent.
   */
  agentId: AgentId;
}
/**
 * The `session.goal.updated` payload: the goal and where it now stands. `reason` is the provider's
 * judge's reason, present exactly when the status is `impossible`.
 */
export interface SessionGoalUpdatedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The agent.
   */
  agentId: AgentId;
  /**
   * The goal.
   */
  goal: SessionGoal;
  /**
   * Where it now stands.
   */
  status: SessionGoalStatus;
  /**
   * The judge's reason, present exactly when the status is `impossible`.
   */
  reason?: string;
}
/**
 * The `session.goal.cleared` payload: whose goal was removed.
 */
export interface SessionGoalClearedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The agent.
   */
  agentId: AgentId;
}

export {
  validateSessionGoal,
  validateSessionGoalClearedPayload,
  validateSessionGoalStatus,
  validateSessionGoalUpdatedPayload,
} from "../checks/session/goal.js";

/** The methods of {@link SESSION_GOAL_METHOD_DESCRIPTORS}, each with its kind. */
export interface SessionGoalMethodDescriptors {
  readonly "session.goal.update": {
    readonly method: "session.goal.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "session.goal.clear": {
    readonly method: "session.goal.clear";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
}
/** The params, result and emission types of each method of {@link SESSION_GOAL_METHOD_DESCRIPTORS}. */
export interface SessionGoalMethodTypes {
  readonly "session.goal.update": {
    readonly params: SessionGoalUpdateRequest;
    readonly result: SessionGoalUpdateResponse;
  };
  readonly "session.goal.clear": {
    readonly params: SessionGoalClearRequest;
    readonly result: SessionAcknowledgment;
  };
}
/** The goal methods' wire contract: name, procedure type and types. */
export const SESSION_GOAL_METHOD_DESCRIPTORS: SessionGoalMethodDescriptors =
  /* @__PURE__ */ Object.freeze({
    "session.goal.update": /* @__PURE__ */ Object.freeze({
      method: "session.goal.update",
      procedureType: "mutation",
      mutating: true,
    }),
    "session.goal.clear": /* @__PURE__ */ Object.freeze({
      method: "session.goal.clear",
      procedureType: "mutation",
      mutating: true,
    }),
  });
