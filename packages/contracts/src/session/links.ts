// The links between sessions as the person reads and changes them: the live related list the
// inspector shows, adding a `related` link and removing one, with the code a removal of a link
// the daemon wrote from an event is refused with.
import { z } from "zod";

import { wireFreeFormString } from "../free-form-string.js";
import { requireMemberToRideOneFrame } from "../jsonrpc/page.js";
import { SubscribeAckResponseSchema, type SubscribeAckResponse } from "../jsonrpc/streaming.js";
import {
  defineMethodDescriptors,
  type MethodDescriptor,
  type SubscriptionMethodDescriptor,
} from "../method-descriptor.js";
import { SessionIdSchema, type SessionId } from "./id.js";
import { SessionVerbResponseSchema, type SessionVerbResponse } from "./methods.js";
import { SESSION_NAME_MAX_LEN } from "./name.js";

/**
 * A `session.linkRemove` that named a link the daemon wrote from an event, which records what
 * happened; only a `related` link is removed.
 */
export const SESSION_LINK_NOT_REMOVABLE_CODE = "session.link_not_removable" as const;

/**
 * How two sessions are linked. Every kind but `related` is written by the daemon when the event
 * that makes it happens; `related` is added on purpose and is the one a person removes.
 */
export type SessionLinkKind =
  | "started"
  | "copied_from"
  | "messaged"
  | "asked"
  | "mentioned"
  | "related";
/** Parses a {@link SessionLinkKind}. */
export const SessionLinkKindSchema: z.ZodType<SessionLinkKind, SessionLinkKind> = z.enum([
  "started",
  "copied_from",
  "messaged",
  "asked",
  "mentioned",
  "related",
]);

/** `session.relatedList`'s input: the session whose related sessions to follow. */
export interface SessionRelatedListRequest {
  sessionId: SessionId;
}
/** Parses a {@link SessionRelatedListRequest}. */
export const SessionRelatedListRequestSchema: z.ZodType<
  SessionRelatedListRequest,
  SessionRelatedListRequest
> = z.object({ sessionId: SessionIdSchema }).strict();

/**
 * One session linked to the followed one.
 *
 * - `name` is absent for an untitled session.
 * - `kind` is the strongest link between the two, and `sessionIsSource` is true where the
 *   followed session started, copied, messaged, asked or mentioned the other.
 * - `messageCount` is on a `messaged` link: how many messages the two traded.
 * - `removable` is true while the pair carries a `related` link, which `Unlink` removes.
 */
export interface SessionRelatedListEntry {
  sessionId: SessionId;
  name?: string | undefined;
  kind: SessionLinkKind;
  sessionIsSource: boolean;
  messageCount?: number | undefined;
  removable: boolean;
}
const SessionRelatedListEntrySchema: z.ZodType<SessionRelatedListEntry> = z
  .object({
    sessionId: SessionIdSchema,
    name: wireFreeFormString(SESSION_NAME_MAX_LEN, "SessionRelatedListEntry.name").optional(),
    kind: SessionLinkKindSchema,
    sessionIsSource: z.boolean(),
    messageCount: z.number().int().positive().optional(),
    removable: z.boolean(),
  })
  .strict();

/**
 * Each `session.relatedList` emission: the whole related list, highest relevance first, sent
 * when the stream opens and again each time a link it depends on is re-scored.
 */
export interface SessionRelatedListUpdate {
  sessionId: SessionId;
  related: SessionRelatedListEntry[];
}
/** Parses a {@link SessionRelatedListUpdate}; the list fits the shared page budget. */
export const SessionRelatedListUpdateSchema: z.ZodType<SessionRelatedListUpdate> = z
  .object({ sessionId: SessionIdSchema, related: z.array(SessionRelatedListEntrySchema) })
  .strict()
  .superRefine((update, issueContext) => {
    requireMemberToRideOneFrame(update.related, "related", issueContext);
  });

/**
 * Adds a `related` link between two sessions, naming both by id so a rename changes nothing;
 * removing one takes the same pair. The two are different sessions: none links to itself.
 */
export interface SessionLinkRequest {
  sessionId: SessionId;
  targetSessionId: SessionId;
}
/** Parses a {@link SessionLinkRequest}. */
export const SessionLinkRequestSchema: z.ZodType<SessionLinkRequest, SessionLinkRequest> = z
  .object({ sessionId: SessionIdSchema, targetSessionId: SessionIdSchema })
  .strict()
  .refine((pair) => pair.sessionId !== pair.targetSessionId, {
    message: "A session cannot be linked to itself.",
  });

/** The session link methods, keyed by method name. */
export interface SessionLinkMethodDescriptors {
  /** The acknowledgment carries only the subscription; the first emission is the list. */
  readonly "session.relatedList": SubscriptionMethodDescriptor<
    "session.relatedList",
    SessionRelatedListRequest,
    SubscribeAckResponse,
    SessionRelatedListUpdate
  >;
  readonly "session.linkAdd": MethodDescriptor<
    "session.linkAdd",
    SessionLinkRequest,
    SessionVerbResponse
  >;
  readonly "session.linkRemove": MethodDescriptor<
    "session.linkRemove",
    SessionLinkRequest,
    SessionVerbResponse
  >;
}

/** The session link methods' wire contract: name, procedure type and schemas. */
export const SESSION_LINK_METHOD_DESCRIPTORS: SessionLinkMethodDescriptors =
  defineMethodDescriptors({
    "session.relatedList": {
      method: "session.relatedList",
      procedureType: "subscription",
      mutating: false,
      requestSchema: SessionRelatedListRequestSchema,
      responseSchema: SubscribeAckResponseSchema,
      emissionSchema: SessionRelatedListUpdateSchema,
    },
    "session.linkAdd": {
      method: "session.linkAdd",
      procedureType: "mutation",
      mutating: true,
      requestSchema: SessionLinkRequestSchema,
      responseSchema: SessionVerbResponseSchema,
    },
    "session.linkRemove": {
      method: "session.linkRemove",
      procedureType: "mutation",
      mutating: true,
      requestSchema: SessionLinkRequestSchema,
      responseSchema: SessionVerbResponseSchema,
    },
  });
