// The `session.created` payload. Kept apart from `session.ts` because it names the lead as
// the live agent list does, and `agent.ts` imports `session.ts`; the event contract imports
// this file, and nothing here imports that contract.
import { z } from "zod";

import { AgentDefinitionIdSchema, type AgentDefinitionId } from "./agent-definition.js";
import { AgentListEntrySchema, type AgentListEntry } from "./agent.js";
import {
  EventCursorSchema,
  SessionIdSchema,
  SessionShapeSchema,
  UserIdSchema,
  type EventCursor,
  type SessionId,
  type SessionShape,
  type UserId,
} from "./session.js";

/** The session a fork was taken from, and the message it was taken at. */
export interface SessionCreatedParent {
  sessionId: SessionId;
  anchorCursor: EventCursor;
}
const SessionCreatedParentSchema: z.ZodType<SessionCreatedParent> = z
  .object({ sessionId: SessionIdSchema, anchorCursor: EventCursorSchema })
  .strict();

/**
 * A session's birth. A session has one lead, born with it rather than joined to it later, so
 * this is the record that brings the lead into the session: `mainAgent` is the lead as the
 * live agent list carries it. It is also the one record of the session's shape at birth, of
 * the session it was forked from (`parent`, present exactly on a fork), and of the saved
 * definition a scratch session tries (`scratchForDefinitionId`). `actor` is the person who
 * created it.
 *
 * A type rather than an interface, so it meets the envelope's open payload record.
 */
export type SessionCreatedPayload = {
  sessionId: SessionId;
  shape: SessionShape;
  mainAgent: AgentListEntry;
  parent?: SessionCreatedParent | undefined;
  scratchForDefinitionId?: AgentDefinitionId | undefined;
  actor?: UserId | undefined;
};
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
