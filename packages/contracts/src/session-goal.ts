// A goal inside a session: the condition one agent works toward until it is met, cleared or
// stopped unmet, set with `session.goalUpdate` and removed with `session.goalClear`, and the two
// events that record each change. A goal is a command used inside a session, never what the
// session is, so nothing here names a session by one. The transcript draws every goal row from
// the two events; there is no separate goal store.
//
// Must not import `./event.js`: it registers the two payloads below as event variants, so an
// import back closes a module-scope cycle that throws at load time.
import { z } from "zod";

import { AgentIdSchema, type AgentId } from "./agent-definition.js";
import type { MethodDescriptor } from "./method-descriptor.js";
import { defineMethodDescriptors } from "./method-descriptor.js";
import { DRIVER_FAILURE_DETAIL_MAX_LEN } from "./provider-driver.js";
import {
  SessionAcknowledgementSchema,
  type SessionAcknowledgement,
} from "./session-controls/methods.js";
import {
  SessionIdSchema,
  wireFreeFormString,
  wireUncappedFreeFormString,
  type SessionId,
} from "./session.js";

/**
 * A goal's condition, as the person wrote it. `text` has no length cap of the app's own; it is
 * not blank and free of NUL, checked as written and never trimmed. Clearing is its
 * own operation, so an update with empty text is refused rather than read as a clear.
 */
export interface SessionGoal {
  text: string;
}
/** Parses a {@link SessionGoal}. */
export const SessionGoalSchema: z.ZodType<SessionGoal, SessionGoal> = z
  .object({ text: wireUncappedFreeFormString("SessionGoal.text") })
  .strict();

const SESSION_GOAL_STATUS_VALUES = [
  "active",
  "paused",
  "blocked",
  "usage-limited",
  "budget-limited",
  "complete",
  "impossible",
] as const;

/**
 * Where a goal stands. `complete` and `impossible` are final; a goal's last status is what its
 * row draws. Only Claude Code sends `impossible`, carrying the judge's reason. Clearing is the
 * event `session.goal_cleared`, never a status.
 */
export type SessionGoalStatus = (typeof SESSION_GOAL_STATUS_VALUES)[number];
/** Parses a {@link SessionGoalStatus}. */
export const SessionGoalStatusSchema: z.ZodType<SessionGoalStatus, SessionGoalStatus> = z.enum(
  SESSION_GOAL_STATUS_VALUES,
);

/** Sets or replaces the goal of one agent in the session. The last write wins. */
export interface SessionGoalUpdateRequest {
  sessionId: SessionId;
  agentId: AgentId;
  goal: SessionGoal;
}
/** Parses a {@link SessionGoalUpdateRequest}. */
export const SessionGoalUpdateRequestSchema: z.ZodType<
  SessionGoalUpdateRequest,
  SessionGoalUpdateRequest
> = z
  .object({ sessionId: SessionIdSchema, agentId: AgentIdSchema, goal: SessionGoalSchema })
  .strict();

/** The accepted goal, echoed exactly as the `session.goal_updated` event carries it. */
export interface SessionGoalUpdateResponse {
  sessionId: SessionId;
  goal: SessionGoal;
}
/** Parses a {@link SessionGoalUpdateResponse}. */
export const SessionGoalUpdateResponseSchema: z.ZodType<SessionGoalUpdateResponse> = z
  .object({ sessionId: SessionIdSchema, goal: SessionGoalSchema })
  .strict();

/** Removes one agent's goal. With no goal set it succeeds, as Codex's own clear does. */
export interface SessionGoalClearRequest {
  sessionId: SessionId;
  agentId: AgentId;
}
/** Parses a {@link SessionGoalClearRequest}. */
export const SessionGoalClearRequestSchema: z.ZodType<
  SessionGoalClearRequest,
  SessionGoalClearRequest
> = z.object({ sessionId: SessionIdSchema, agentId: AgentIdSchema }).strict();

/**
 * The `session.goal_updated` payload: the goal and where it now stands. `reason` is the
 * provider's judge's reason, present exactly when the status is `impossible`. A type alias
 * because only an alias has the index signature the envelope's record-typed payload needs.
 */
export type SessionGoalUpdatedPayload = {
  sessionId: SessionId;
  agentId: AgentId;
  goal: SessionGoal;
  status: SessionGoalStatus;
  reason?: string | undefined;
};
/** Parses a {@link SessionGoalUpdatedPayload}; a reason off the `impossible` status is refused. */
export const SessionGoalUpdatedPayloadSchema: z.ZodType<SessionGoalUpdatedPayload> = z
  .object({
    sessionId: SessionIdSchema,
    agentId: AgentIdSchema,
    goal: SessionGoalSchema,
    status: SessionGoalStatusSchema,
    // The judge's words are provider output, bounded as other provider detail is.
    reason: wireFreeFormString(
      DRIVER_FAILURE_DETAIL_MAX_LEN,
      "SessionGoalUpdatedPayload.reason",
    ).optional(),
  })
  .strict()
  .refine((payload) => (payload.status === "impossible") === (payload.reason !== undefined), {
    message: "A goal carries a reason exactly when its status is impossible.",
    path: ["reason"],
  });

/** The `session.goal_cleared` payload: whose goal was removed. */
export type SessionGoalClearedPayload = {
  sessionId: SessionId;
  agentId: AgentId;
};
/** Parses a {@link SessionGoalClearedPayload}. */
export const SessionGoalClearedPayloadSchema: z.ZodType<SessionGoalClearedPayload> = z
  .object({ sessionId: SessionIdSchema, agentId: AgentIdSchema })
  .strict();

/** The two `session.*` goal methods, keyed by method name. */
export interface SessionGoalMethodDescriptors {
  readonly "session.goalUpdate": MethodDescriptor<
    "session.goalUpdate",
    SessionGoalUpdateRequest,
    SessionGoalUpdateResponse
  >;
  readonly "session.goalClear": MethodDescriptor<
    "session.goalClear",
    SessionGoalClearRequest,
    SessionAcknowledgement
  >;
}
/**
 * The goal methods' wire contract: name, procedure type and schemas.
 *
 * @consumedBy the daemon's `session.goalUpdate` and `session.goalClear` handlers
 */
export const SESSION_GOAL_METHOD_DESCRIPTORS: SessionGoalMethodDescriptors =
  defineMethodDescriptors({
    "session.goalUpdate": {
      method: "session.goalUpdate",
      procedureType: "mutation",
      mutating: true,
      requestSchema: SessionGoalUpdateRequestSchema,
      responseSchema: SessionGoalUpdateResponseSchema,
    },
    "session.goalClear": {
      method: "session.goalClear",
      procedureType: "mutation",
      mutating: true,
      requestSchema: SessionGoalClearRequestSchema,
      responseSchema: SessionAcknowledgementSchema,
    },
  });
