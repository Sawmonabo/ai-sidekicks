// The statements the group verbs write. A chat has no project, so it matches none of these guards.
// Every check that decides a group write is one of these statements, inside that write.

import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { SessionGroupId } from "@ai-sidekicks/contracts/session/groups";

import type { WriteStatement } from "../../database/statement.js";
import { sessionProjectSql } from "../directory/lookups.js";

// The project of the session bound as `@sessionId`.
const SESSION_PROJECT_SQL = sessionProjectSql("@sessionId");

const PLACE_SESSION_SQL = `UPDATE sessions SET group_id = @groupId
  WHERE id = @sessionId
    AND shape = 'project'
    AND EXISTS (SELECT 1 FROM session_groups
                 WHERE id = @groupId AND project_id = ${SESSION_PROJECT_SQL})`;

/**
 * Puts the session in the group: one UPDATE of `sessions.group_id` that holds only while the
 * session is a project session and the group belongs to its project, expecting one row. A refusal
 * means a chat, a group of another project, or no such group or session.
 */
export function sessionGroupPlacementStatement(placement: {
  readonly sessionId: SessionId;
  readonly groupId: SessionGroupId;
}): WriteStatement {
  return {
    sql: PLACE_SESSION_SQL,
    bindings: { sessionId: placement.sessionId, groupId: placement.groupId },
    expectedRowCount: 1,
  };
}

/** Holds only while the session is a project session bound to its project. */
export function projectSessionStatement(sessionId: SessionId): WriteStatement {
  return {
    sql: `SELECT 1 FROM sessions
           WHERE id = @sessionId AND shape = 'project' AND ${SESSION_PROJECT_SQL} IS NOT NULL`,
    bindings: { sessionId },
    expectedRowCount: 1,
  };
}

/** Holds only while no group of the session's project carries the folded name. */
export function groupNameFreeInSessionProjectStatement(
  sessionId: SessionId,
  nameFolded: string,
): WriteStatement {
  return {
    sql: `SELECT 1 FROM session_groups
           WHERE project_id = ${SESSION_PROJECT_SQL} AND name_folded = @nameFolded`,
    bindings: { sessionId, nameFolded },
    expectedRowCount: 0,
  };
}

/** Makes a group in the session's project; refused when the session has no project. */
export function insertGroupStatement(group: {
  readonly groupId: SessionGroupId;
  readonly sessionId: SessionId;
  readonly name: string;
  readonly nameFolded: string;
  readonly createdAt: string;
}): WriteStatement {
  return {
    sql: `INSERT INTO session_groups (id, project_id, name, name_folded, created_at)
          SELECT @groupId, project.id, @name, @nameFolded, @createdAt
            FROM (SELECT ${SESSION_PROJECT_SQL} AS id) AS project
           WHERE project.id IS NOT NULL`,
    bindings: group,
    expectedRowCount: 1,
  };
}

/** Takes the session out of any group; a chat, in none, changes nothing but still matches. */
export function leaveGroupStatement(sessionId: SessionId): WriteStatement {
  return {
    sql: "UPDATE sessions SET group_id = NULL WHERE id = @sessionId",
    bindings: { sessionId },
    expectedRowCount: 1,
  };
}

/**
 * Removes every group of the session's project that no session sits in, so a move that empties a
 * group removes it in the same write.
 */
export function removeEmptyGroupsOfSessionProjectStatement(sessionId: SessionId): WriteStatement {
  return {
    sql: `DELETE FROM session_groups
           WHERE project_id = ${SESSION_PROJECT_SQL}
             AND NOT EXISTS (SELECT 1 FROM sessions WHERE group_id = session_groups.id)`,
    bindings: { sessionId },
  };
}

/** Holds only while the group exists. */
export function groupExistsStatement(groupId: SessionGroupId): WriteStatement {
  return {
    sql: "SELECT 1 FROM session_groups WHERE id = @groupId",
    bindings: { groupId },
    expectedRowCount: 1,
  };
}

/** Holds only while no other group of the group's project carries the folded name. */
export function groupNameFreeForRenameStatement(
  groupId: SessionGroupId,
  nameFolded: string,
): WriteStatement {
  return {
    sql: `SELECT 1 FROM session_groups AS other
           WHERE other.project_id = (SELECT project_id FROM session_groups WHERE id = @groupId)
             AND other.name_folded = @nameFolded
             AND other.id <> @groupId`,
    bindings: { groupId, nameFolded },
    expectedRowCount: 0,
  };
}

/** Answers the ids of the sessions sitting in the group. */
export function groupMembersStatement(groupId: SessionGroupId): WriteStatement {
  return { sql: "SELECT id FROM sessions WHERE group_id = @groupId", bindings: { groupId } };
}

/** Renames the group, writing the fold beside the name. */
export function renameGroupStatement(
  groupId: SessionGroupId,
  name: string,
  nameFolded: string,
): WriteStatement {
  return {
    sql: "UPDATE session_groups SET name = @name, name_folded = @nameFolded WHERE id = @groupId",
    bindings: { groupId, name, nameFolded },
    expectedRowCount: 1,
  };
}

/** Puts every session of the group back loose and answers their ids. */
export function releaseGroupSessionsStatement(groupId: SessionGroupId): WriteStatement {
  return {
    sql: "UPDATE sessions SET group_id = NULL WHERE group_id = @groupId RETURNING id",
    bindings: { groupId },
  };
}

/** Removes the group itself. */
export function deleteGroupStatement(groupId: SessionGroupId): WriteStatement {
  return { sql: "DELETE FROM session_groups WHERE id = @groupId", bindings: { groupId } };
}
