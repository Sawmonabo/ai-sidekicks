// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// A project's session groups as the person places sessions in them.

import type { SchemaCheck } from "../../schema-check.js";
import { validateEmptyPayload } from "../checks/method-descriptor.js";
import {
  validateSessionGroupCreateRequest,
  validateSessionGroupCreateResponse,
  validateSessionGroupMoveRequest,
  validateSessionGroupRenameRequest,
  validateSessionGroupUngroupRequest,
} from "../checks/session/groups.js";
import type { EmptyPayload } from "../method-descriptor.js";
import type { SessionId } from "./id.js";

/**
 * Identifies one session group of a project; the daemon mints it.
 */
export type SessionGroupId = string & { readonly __brand: "SessionGroupId" };

/**
 * Makes a group in the session's project with this session in it, so no group is ever empty. A
 * name another group of the project holds, ignoring case, is refused; a chat sits in no group.
 */
export interface SessionGroupCreateRequest {
  /**
   * The session the group starts with.
   */
  sessionId: SessionId;
  /**
   * The group's name.
   */
  name: string;
}
/**
 * The group `session.group.create` made.
 */
export interface SessionGroupCreateResponse {
  /**
   * The group.
   */
  groupId: SessionGroupId;
}
/**
 * Moves the session into a group of its own project, leaving any group it was in; `groupId`
 * `null` takes it out among the project's loose sessions. A group left with no session is removed.
 */
export interface SessionGroupMoveRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The group, or `null` for none.
   */
  groupId: SessionGroupId | null;
}
/**
 * Renames a group, held to the same uniqueness in its project as a new group's name.
 */
export interface SessionGroupRenameRequest {
  /**
   * The group.
   */
  groupId: SessionGroupId;
  /**
   * Its new name.
   */
  name: string;
}
/**
 * Ungroups a group: its sessions go back loose, and nothing is archived or closed.
 */
export interface SessionGroupUngroupRequest {
  /**
   * The group.
   */
  groupId: SessionGroupId;
}

export {
  validateSessionGroupCreateRequest,
  validateSessionGroupCreateResponse,
  validateSessionGroupId,
  validateSessionGroupMoveRequest,
  validateSessionGroupRenameRequest,
  validateSessionGroupUngroupRequest,
} from "../checks/session/groups.js";

/** The methods of {@link SESSION_GROUP_METHOD_DESCRIPTORS}, each with its checks. */
export interface SessionGroupMethodDescriptors {
  readonly "session.group.create": {
    readonly method: "session.group.create";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionGroupCreateRequest>;
    readonly responseCheck: SchemaCheck<SessionGroupCreateResponse>;
  };
  readonly "session.group.move": {
    readonly method: "session.group.move";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionGroupMoveRequest>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
  readonly "session.group.rename": {
    readonly method: "session.group.rename";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionGroupRenameRequest>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
  readonly "session.group.ungroup": {
    readonly method: "session.group.ungroup";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionGroupUngroupRequest>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
}
/** The session group methods' wire contract: name, procedure type and types. */
export const SESSION_GROUP_METHOD_DESCRIPTORS: SessionGroupMethodDescriptors =
  /* @__PURE__ */ Object.freeze({
    "session.group.create": /* @__PURE__ */ Object.freeze({
      method: "session.group.create",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateSessionGroupCreateRequest,
      responseCheck: validateSessionGroupCreateResponse,
    }),
    "session.group.move": /* @__PURE__ */ Object.freeze({
      method: "session.group.move",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateSessionGroupMoveRequest,
      responseCheck: validateEmptyPayload,
    }),
    "session.group.rename": /* @__PURE__ */ Object.freeze({
      method: "session.group.rename",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateSessionGroupRenameRequest,
      responseCheck: validateEmptyPayload,
    }),
    "session.group.ungroup": /* @__PURE__ */ Object.freeze({
      method: "session.group.ungroup",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateSessionGroupUngroupRequest,
      responseCheck: validateEmptyPayload,
    }),
  });
