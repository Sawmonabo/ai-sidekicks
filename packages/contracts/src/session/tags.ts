// A session's tags as the person adds and removes them on the inspector, and the tags in use that
// `Add tag` suggests.
import { z } from "zod";

import { requireMemberToRideOneFrame } from "../jsonrpc/page.js";
import {
  EmptyPayloadSchema,
  defineMethodDescriptors,
  type EmptyPayload,
  type MethodDescriptor,
} from "../method-descriptor.js";
import { TagListSchema, TagSchema } from "../tag.js";
import { SessionIdSchema, type SessionId } from "./id.js";
import { SessionVerbResponseSchema, type SessionVerbResponse } from "./methods.js";

/**
 * Adds a tag to a session or removes one. A tag is matched ignoring case and nests with `/`; one
 * the tag rule refuses never reaches the daemon.
 */
export interface SessionTagRequest {
  sessionId: SessionId;
  tag: string;
}
/** Parses a {@link SessionTagRequest}. */
export const SessionTagRequestSchema: z.ZodType<SessionTagRequest, SessionTagRequest> = z
  .object({
    sessionId: SessionIdSchema,
    tag: TagSchema,
  })
  .strict();

/** The tags in use across every session, which `Add tag` suggests. */
export interface SessionTagListResponse {
  tags: string[];
}
/** Parses a {@link SessionTagListResponse}; the tags fit the shared page budget. */
export const SessionTagListResponseSchema: z.ZodType<SessionTagListResponse> = z
  .object({
    tags: TagListSchema,
  })
  .strict()
  .superRefine((response, issueContext) => {
    requireMemberToRideOneFrame(response.tags, "tags", issueContext);
  });

/** The session tag methods, keyed by method name. */
export interface SessionTagMethodDescriptors {
  readonly "session.tagAdd": MethodDescriptor<
    "session.tagAdd",
    SessionTagRequest,
    SessionVerbResponse
  >;
  readonly "session.tagRemove": MethodDescriptor<
    "session.tagRemove",
    SessionTagRequest,
    SessionVerbResponse
  >;
  readonly "session.tagList": MethodDescriptor<
    "session.tagList",
    EmptyPayload,
    SessionTagListResponse
  >;
}

/** The session tag methods' wire contract: name, procedure type and schemas. */
export const SESSION_TAG_METHOD_DESCRIPTORS: SessionTagMethodDescriptors = defineMethodDescriptors({
  "session.tagAdd": {
    method: "session.tagAdd",
    procedureType: "mutation",
    mutating: true,
    requestSchema: SessionTagRequestSchema,
    responseSchema: SessionVerbResponseSchema,
  },
  "session.tagRemove": {
    method: "session.tagRemove",
    procedureType: "mutation",
    mutating: true,
    requestSchema: SessionTagRequestSchema,
    responseSchema: SessionVerbResponseSchema,
  },
  "session.tagList": {
    method: "session.tagList",
    procedureType: "query",
    mutating: false,
    requestSchema: EmptyPayloadSchema,
    responseSchema: SessionTagListResponseSchema,
  },
});
