// A project's session groups as the person places sessions in them: making a group with a
// session in it, moving a session in or out, renaming a group and ungrouping it, with the codes
// those verbs refuse with. A client reads every change from the live `session.list`.
import { z } from "zod";

import { wireFreeFormString } from "../free-form-string.js";
import { brandedUuidIdSchema } from "../internal/branded.js";
import { defineMethodDescriptors, type MethodDescriptor } from "../method-descriptor.js";
import { SessionIdSchema, type SessionId } from "./id.js";
import { SessionVerbResponseSchema, type SessionVerbResponse } from "./methods.js";
import { SESSION_NAME_MAX_LEN } from "./name.js";

/** Identifies one session group of a project; the daemon mints it. */
export type SessionGroupId = string & { readonly __brand: "SessionGroupId" };
/** Parses a {@link SessionGroupId}. */
export const SessionGroupIdSchema: z.ZodType<SessionGroupId, SessionGroupId> =
  brandedUuidIdSchema<SessionGroupId>("SessionGroupId");

/**
 * A group name another group of the session's project already holds, ignoring case, on
 * `session.groupCreate` or `session.groupRename`; nothing is written.
 */
export const SESSION_GROUP_NAME_TAKEN_CODE = "session.group_name_taken" as const;

/**
 * A chat asked into a group, or a session asked into a group of another project, on
 * `session.groupCreate`, `session.groupMove` or `session.create`; nothing is written.
 */
export const SESSION_GROUP_REFUSED_CODE = "session.group_refused" as const;

/**
 * Makes a group in the session's project with this session in it, so no group is ever empty. A
 * name another group of the project holds, ignoring case, is refused with
 * {@link SESSION_GROUP_NAME_TAKEN_CODE}; a chat sits in no group.
 */
export interface SessionGroupCreateRequest {
  sessionId: SessionId;
  name: string;
}
/** Parses a {@link SessionGroupCreateRequest}. */
export const SessionGroupCreateRequestSchema: z.ZodType<
  SessionGroupCreateRequest,
  SessionGroupCreateRequest
> = z
  .object({
    sessionId: SessionIdSchema,
    name: wireFreeFormString(SESSION_NAME_MAX_LEN, "SessionGroupCreateRequest.name"),
  })
  .strict();

/** The group `session.groupCreate` made. */
export interface SessionGroupCreateResponse {
  groupId: SessionGroupId;
}
/** Parses a {@link SessionGroupCreateResponse}. */
export const SessionGroupCreateResponseSchema: z.ZodType<SessionGroupCreateResponse> = z
  .object({ groupId: SessionGroupIdSchema })
  .strict();

/**
 * Moves the session into a group of its own project, leaving any group it was in; `groupId`
 * `null` takes it out among the project's loose sessions. A group left with no session is
 * removed.
 */
export interface SessionGroupMoveRequest {
  sessionId: SessionId;
  groupId: SessionGroupId | null;
}
/** Parses a {@link SessionGroupMoveRequest}. */
export const SessionGroupMoveRequestSchema: z.ZodType<
  SessionGroupMoveRequest,
  SessionGroupMoveRequest
> = z.object({ sessionId: SessionIdSchema, groupId: SessionGroupIdSchema.nullable() }).strict();

/** Renames a group, held to the same uniqueness in its project as a new group's name. */
export interface SessionGroupRenameRequest {
  groupId: SessionGroupId;
  name: string;
}
/** Parses a {@link SessionGroupRenameRequest}. */
export const SessionGroupRenameRequestSchema: z.ZodType<
  SessionGroupRenameRequest,
  SessionGroupRenameRequest
> = z
  .object({
    groupId: SessionGroupIdSchema,
    name: wireFreeFormString(SESSION_NAME_MAX_LEN, "SessionGroupRenameRequest.name"),
  })
  .strict();

/** Ungroups a group: its sessions go back loose, and nothing is archived or closed. */
export interface SessionGroupUngroupRequest {
  groupId: SessionGroupId;
}
/** Parses a {@link SessionGroupUngroupRequest}. */
export const SessionGroupUngroupRequestSchema: z.ZodType<
  SessionGroupUngroupRequest,
  SessionGroupUngroupRequest
> = z.object({ groupId: SessionGroupIdSchema }).strict();

/** The session group methods, keyed by method name. */
export interface SessionGroupMethodDescriptors {
  readonly "session.groupCreate": MethodDescriptor<
    "session.groupCreate",
    SessionGroupCreateRequest,
    SessionGroupCreateResponse
  >;
  readonly "session.groupMove": MethodDescriptor<
    "session.groupMove",
    SessionGroupMoveRequest,
    SessionVerbResponse
  >;
  readonly "session.groupRename": MethodDescriptor<
    "session.groupRename",
    SessionGroupRenameRequest,
    SessionVerbResponse
  >;
  readonly "session.groupUngroup": MethodDescriptor<
    "session.groupUngroup",
    SessionGroupUngroupRequest,
    SessionVerbResponse
  >;
}

/** The session group methods' wire contract: name, procedure type and schemas. */
export const SESSION_GROUP_METHOD_DESCRIPTORS: SessionGroupMethodDescriptors =
  defineMethodDescriptors({
    "session.groupCreate": {
      method: "session.groupCreate",
      procedureType: "mutation",
      mutating: true,
      requestSchema: SessionGroupCreateRequestSchema,
      responseSchema: SessionGroupCreateResponseSchema,
    },
    "session.groupMove": {
      method: "session.groupMove",
      procedureType: "mutation",
      mutating: true,
      requestSchema: SessionGroupMoveRequestSchema,
      responseSchema: SessionVerbResponseSchema,
    },
    "session.groupRename": {
      method: "session.groupRename",
      procedureType: "mutation",
      mutating: true,
      requestSchema: SessionGroupRenameRequestSchema,
      responseSchema: SessionVerbResponseSchema,
    },
    "session.groupUngroup": {
      method: "session.groupUngroup",
      procedureType: "mutation",
      mutating: true,
      requestSchema: SessionGroupUngroupRequestSchema,
      responseSchema: SessionVerbResponseSchema,
    },
  });
