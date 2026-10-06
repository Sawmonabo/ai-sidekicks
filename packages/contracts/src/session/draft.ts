// The composer's daemon-held store for one session: the unsent draft, the staged files, covering
// part of a staged picture, and the refusals staging can answer with.
//
// The daemon holds all of it, scoped to the session, so a half-typed message and its staged files
// reach the person's other devices and Send needs no upload step. Typed unsent text is never
// written to window storage. A staged file is copied to the daemon when it is staged and kept
// outside the checkout, so it survives a move of the working folder and never shows in a diff;
// from then on it is addressed by its artifact id and its original path is never read again.
import { z } from "zod";

import { defineMethodDescriptors, type MethodDescriptor } from "../method-descriptor.js";
import { McpServerNameSchema } from "../mcp/server.js";
import { ArtifactIdSchema, type ArtifactId } from "../artifacts/id.js";
import { FILE_PATH_MAX_LEN } from "../free-form-string.js";
import { SessionIdSchema, type SessionId } from "./id.js";
import { countSchema, isoDateTimeSchema } from "../internal/wire-scalars.js";

/**
 * Saves a session's draft. `text` is the whole draft and replaces the one held; an empty string
 * clears it, which is what Send does. The text has no length limit of its own: a message's limit
 * is the send's to state, so a draft the send would take is never refused here.
 */
export interface SessionDraftUpdateRequest {
  sessionId: SessionId;
  text: string;
}
/** Parses a {@link SessionDraftUpdateRequest}. */
export const SessionDraftUpdateRequestSchema: z.ZodType<
  SessionDraftUpdateRequest,
  SessionDraftUpdateRequest
> = z.object({ sessionId: SessionIdSchema, text: z.string() }).strict();

/** When the daemon stored the draft. */
export interface SessionDraftUpdateResponse {
  sessionId: SessionId;
  updatedAt: string;
}
/** Parses a {@link SessionDraftUpdateResponse}. */
export const SessionDraftUpdateResponseSchema: z.ZodType<SessionDraftUpdateResponse> = z
  .object({ sessionId: SessionIdSchema, updatedAt: isoDateTimeSchema })
  .strict();

/**
 * One staged file as the daemon holds it. Every member is what the daemon found in the bytes it
 * copied, never what the caller declared: the name it stored the file under, the media type it
 * read from the bytes, and the size it measured.
 */
export interface SessionAttachmentSummary {
  artifactId: ArtifactId;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}
/** Parses a {@link SessionAttachmentSummary}. */
export const SessionAttachmentSummarySchema: z.ZodType<SessionAttachmentSummary> = z
  .object({
    artifactId: ArtifactIdSchema,
    fileName: z.string().min(1).max(FILE_PATH_MAX_LEN),
    mimeType: z.string().min(1),
    sizeBytes: countSchema,
  })
  .strict();

/**
 * A file picked, dropped or pasted, by its path. The renderer only holds an opaque token for a
 * path, and the main process turns it into this path on its way to the daemon, so a path reaches
 * the daemon only from the main process or the command line.
 */
export interface SessionAttachmentFileItem {
  kind: "file";
  /** The client's id for this one item, so a retried stage never stages it twice. */
  clientStagingId: string;
  path: string;
}

/**
 * A resource a tool server publishes, by the session's name for the server and the resource's
 * own address. The address names the resource on that server and is never read as a path.
 */
export interface SessionAttachmentMcpResourceItem {
  kind: "mcpResource";
  clientStagingId: string;
  serverName: string;
  uri: string;
}

/** One thing to stage. */
export type SessionAttachmentItem = SessionAttachmentFileItem | SessionAttachmentMcpResourceItem;

/**
 * Stages files for the next message. The count is not limited here: a pick over the message's
 * limit stages as many as fit and refuses each of the rest by name, so no file is dropped
 * silently.
 */
export interface SessionAttachmentAddRequest {
  sessionId: SessionId;
  items: SessionAttachmentItem[];
}
/** Parses a {@link SessionAttachmentAddRequest}; an empty list is refused. */
export const SessionAttachmentAddRequestSchema: z.ZodType<
  SessionAttachmentAddRequest,
  SessionAttachmentAddRequest
> = z
  .object({
    sessionId: SessionIdSchema,
    items: z
      .array(
        z.discriminatedUnion("kind", [
          z
            .object({
              kind: z.literal("file"),
              clientStagingId: z.uuid(),
              path: z.string().min(1).max(FILE_PATH_MAX_LEN),
            })
            .strict(),
          z
            .object({
              kind: z.literal("mcpResource"),
              clientStagingId: z.uuid(),
              serverName: McpServerNameSchema,
              uri: z.string().min(1),
            })
            .strict(),
        ]),
      )
      .min(1),
  })
  .strict();

/** The code for a file the session cannot stage. */
export const SESSION_ATTACHMENT_REFUSED_CODE = "session.attachment_refused" as const;
/** The type of {@link SESSION_ATTACHMENT_REFUSED_CODE}. */
export type SessionAttachmentRefusedCode = typeof SESSION_ATTACHMENT_REFUSED_CODE;

/**
 * Why the session could not stage a file:
 *
 * - `count_limit`: the message already carries as many files as it may.
 * - `folder`: a folder was offered; an agent reads a folder where it is.
 * - `provider_takes_no_attachments`: the session's provider accepts no files.
 * - `card_waiting`: a card above the composer is waiting on the person.
 * - `copy_failed`: the copy to the daemon did not complete.
 */
export const SESSION_ATTACHMENT_REFUSED_REASONS = [
  "count_limit",
  "folder",
  "provider_takes_no_attachments",
  "card_waiting",
  "copy_failed",
] as const;
/** One of {@link SESSION_ATTACHMENT_REFUSED_REASONS}. */
export type SessionAttachmentRefusedReason = (typeof SESSION_ATTACHMENT_REFUSED_REASONS)[number];

/** Why one item was not staged: the code and its reason. */
export interface SessionAttachmentRefusalCause {
  code: SessionAttachmentRefusedCode;
  reason: SessionAttachmentRefusedReason;
}

/** One item the daemon did not stage, by the name the refusal line shows. */
export interface SessionAttachmentRefusal {
  clientStagingId: string;
  name: string;
  cause: SessionAttachmentRefusalCause;
}
const SessionAttachmentRefusalSchema: z.ZodType<SessionAttachmentRefusal> = z
  .object({
    clientStagingId: z.uuid(),
    name: z.string().min(1),
    cause: z
      .object({
        code: z.literal(SESSION_ATTACHMENT_REFUSED_CODE),
        reason: z.enum(SESSION_ATTACHMENT_REFUSED_REASONS),
      })
      .strict(),
  })
  .strict();

/**
 * The whole staged set after the add, so a client draws what the daemon holds rather than
 * merging its own add, and each item it did not stage with the cause.
 */
export interface SessionAttachmentAddResponse {
  sessionId: SessionId;
  attachments: SessionAttachmentSummary[];
  refused: SessionAttachmentRefusal[];
}
/** Parses a {@link SessionAttachmentAddResponse}. */
export const SessionAttachmentAddResponseSchema: z.ZodType<SessionAttachmentAddResponse> = z
  .object({
    sessionId: SessionIdSchema,
    attachments: z.array(SessionAttachmentSummarySchema),
    refused: z.array(SessionAttachmentRefusalSchema),
  })
  .strict();

/**
 * Unstages one file. The artifact itself keeps its own life; only its place in the staged set
 * goes. Removing a file that is no longer staged answers with the set as it is.
 */
export interface SessionAttachmentRemoveRequest {
  sessionId: SessionId;
  artifactId: ArtifactId;
}
/** Parses a {@link SessionAttachmentRemoveRequest}. */
export const SessionAttachmentRemoveRequestSchema: z.ZodType<
  SessionAttachmentRemoveRequest,
  SessionAttachmentRemoveRequest
> = z.object({ sessionId: SessionIdSchema, artifactId: ArtifactIdSchema }).strict();

/** The whole staged set left after the removal. */
export interface SessionAttachmentRemoveResponse {
  sessionId: SessionId;
  attachments: SessionAttachmentSummary[];
}
/** Parses a {@link SessionAttachmentRemoveResponse}. */
export const SessionAttachmentRemoveResponseSchema: z.ZodType<SessionAttachmentRemoveResponse> = z
  .object({ sessionId: SessionIdSchema, attachments: z.array(SessionAttachmentSummarySchema) })
  .strict();

/** One box to cover, in the picture's own pixels from its top-left corner. */
export interface SessionAttachmentCoverBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Covers parts of a staged picture before Send. The daemon draws the boxes into the pixels,
 * stores the covered copy as a new artifact that takes the old one's place in the staged set, and
 * deletes the uncovered copy, so the provider only ever receives the covered picture. A picture
 * already sent cannot be covered.
 */
export interface SessionAttachmentCoverRequest {
  attachmentId: ArtifactId;
  boxes: SessionAttachmentCoverBox[];
}
/** Parses a {@link SessionAttachmentCoverRequest}; an empty box list or an empty box is refused. */
export const SessionAttachmentCoverRequestSchema: z.ZodType<
  SessionAttachmentCoverRequest,
  SessionAttachmentCoverRequest
> = z
  .object({
    attachmentId: ArtifactIdSchema,
    boxes: z
      .array(
        z
          .object({
            x: countSchema,
            y: countSchema,
            width: z.number().int().positive(),
            height: z.number().int().positive(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

/** The covered copy, which is now the staged attachment. */
export interface SessionAttachmentCoverResponse {
  attachment: SessionAttachmentSummary;
}
/** Parses a {@link SessionAttachmentCoverResponse}. */
export const SessionAttachmentCoverResponseSchema: z.ZodType<SessionAttachmentCoverResponse> = z
  .object({ attachment: SessionAttachmentSummarySchema })
  .strict();

/** The composer store's methods, keyed by method name. */
export interface SessionDraftMethodDescriptors {
  readonly "session.draftUpdate": MethodDescriptor<
    "session.draftUpdate",
    SessionDraftUpdateRequest,
    SessionDraftUpdateResponse
  >;
  readonly "session.attachmentAdd": MethodDescriptor<
    "session.attachmentAdd",
    SessionAttachmentAddRequest,
    SessionAttachmentAddResponse
  >;
  readonly "session.attachmentRemove": MethodDescriptor<
    "session.attachmentRemove",
    SessionAttachmentRemoveRequest,
    SessionAttachmentRemoveResponse
  >;
  readonly "session.attachmentCover": MethodDescriptor<
    "session.attachmentCover",
    SessionAttachmentCoverRequest,
    SessionAttachmentCoverResponse
  >;
}

/** The composer store's methods, each with its schemas. */
export const SESSION_DRAFT_METHOD_DESCRIPTORS: SessionDraftMethodDescriptors =
  defineMethodDescriptors({
    "session.draftUpdate": {
      method: "session.draftUpdate",
      procedureType: "mutation",
      mutating: true,
      requestSchema: SessionDraftUpdateRequestSchema,
      responseSchema: SessionDraftUpdateResponseSchema,
    },
    "session.attachmentAdd": {
      method: "session.attachmentAdd",
      procedureType: "mutation",
      mutating: true,
      requestSchema: SessionAttachmentAddRequestSchema,
      responseSchema: SessionAttachmentAddResponseSchema,
    },
    "session.attachmentRemove": {
      method: "session.attachmentRemove",
      procedureType: "mutation",
      mutating: true,
      requestSchema: SessionAttachmentRemoveRequestSchema,
      responseSchema: SessionAttachmentRemoveResponseSchema,
    },
    "session.attachmentCover": {
      method: "session.attachmentCover",
      procedureType: "mutation",
      mutating: true,
      requestSchema: SessionAttachmentCoverRequestSchema,
      responseSchema: SessionAttachmentCoverResponseSchema,
    },
  });
