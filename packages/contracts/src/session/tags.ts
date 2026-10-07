// A session's tags as the person adds and removes them on the inspector, the tags in use that
// `Add tag` suggests, and the code a tag the daemon will not hold is refused with.
import { z } from "zod";

import { wireFreeFormString } from "../free-form-string.js";
import {
  EmptyPayloadSchema,
  defineMethodDescriptors,
  type EmptyPayload,
  type MethodDescriptor,
} from "../method-descriptor.js";
import { SessionIdSchema, type SessionId } from "./id.js";
import {
  SESSION_NAME_MAX_LEN,
  SessionVerbResponseSchema,
  type SessionVerbResponse,
} from "./methods.js";

/** A `session.tagAdd` whose tag holds a space or is empty; nothing is written. */
export const SESSION_TAG_REFUSED_CODE = "session.tag_refused" as const;

/**
 * Adds a tag to a session or removes one. A tag is matched ignoring case and nests with `/`.
 * The tag is parsed only for its length and a NUL byte, so an empty tag or one holding a space
 * reaches the daemon and is refused with {@link SESSION_TAG_REFUSED_CODE}.
 */
export interface SessionTagRequest {
  sessionId: SessionId;
  tag: string;
}
/** Parses a {@link SessionTagRequest}. */
export const SessionTagRequestSchema: z.ZodType<SessionTagRequest, SessionTagRequest> = z
  .object({
    sessionId: SessionIdSchema,
    tag: z
      .string()
      .max(SESSION_NAME_MAX_LEN)
      .refine((tag) => !tag.includes("\0"), {
        message: "SessionTagRequest.tag MUST NOT contain a NUL byte.",
      }),
  })
  .strict();

/** The tags in use across every session, which `Add tag` suggests. */
export interface SessionTagListResponse {
  tags: string[];
}
/** Parses a {@link SessionTagListResponse}. */
export const SessionTagListResponseSchema: z.ZodType<SessionTagListResponse> = z
  .object({
    tags: z.array(wireFreeFormString(SESSION_NAME_MAX_LEN, "SessionTagListResponse.tags")),
  })
  .strict();

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
