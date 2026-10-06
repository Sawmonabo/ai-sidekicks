// The `session.created` payload. Kept apart from `session/methods.ts` because `agent/methods.ts`
// imports `session/methods.ts` and this payload names the lead as the live agent list does.
import { z } from "zod";

import { AgentDefinitionIdSchema, type AgentDefinitionId } from "../agent/definition.js";
import { AgentListEntrySchema, type AgentListEntry } from "../agent/methods.js";
import { SessionShapeSchema, type SessionShape } from "./methods.js";
import {
  EventCursorSchema,
  SessionIdSchema,
  UserIdSchema,
  type EventCursor,
  type SessionId,
  type UserId,
} from "./id.js";

/** The session a fork was taken from, and the message it was taken at. */
export interface SessionCreatedParent {
  sessionId: SessionId;
  anchorCursor: EventCursor;
}
const SessionCreatedParentSchema: z.ZodType<SessionCreatedParent> = z
  .object({ sessionId: SessionIdSchema, anchorCursor: EventCursorSchema })
  .strict();

/**
 * A session's birth, bringing in its lead as `mainAgent`. `parent` is present exactly on a fork,
 * and `scratchForDefinitionId` names the saved definition a scratch session tries.
 */
export type SessionCreatedPayload = {
  sessionId: SessionId;
  shape: SessionShape;
  mainAgent: AgentListEntry;
  parent?: SessionCreatedParent | undefined;
  scratchForDefinitionId?: AgentDefinitionId | undefined;
  actor?: UserId | undefined;
};
/** Parses a {@link SessionCreatedPayload}. */
export const SessionCreatedPayloadSchema: z.ZodType<SessionCreatedPayload> = z
  .object({
    sessionId: SessionIdSchema,
    shape: SessionShapeSchema,
    mainAgent: AgentListEntrySchema,
    parent: SessionCreatedParentSchema.optional(),
    scratchForDefinitionId: AgentDefinitionIdSchema.optional(),
    actor: UserIdSchema.optional(),
  })
  .strict();
