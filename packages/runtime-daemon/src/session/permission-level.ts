// The permission level a session runs at, a column of its `sessions` row: every process the daemon
// opens or resumes for the session starts at it, and a level move stores it once the provider took
// it.

import type { Database } from "better-sqlite3";

import type { PermissionLevel } from "@ai-sidekicks/contracts/session/controls/methods";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { WriteStatement } from "../database/statement.js";

/** The statement storing the level a session moved to; it refuses a session with no row. */
export function permissionLevelChangeStatement(
  sessionId: SessionId,
  permissionLevel: PermissionLevel,
): WriteStatement {
  return {
    sql: "UPDATE sessions SET permission_level = @permissionLevel WHERE id = @sessionId",
    bindings: { sessionId, permissionLevel },
    expectedRowCount: 1,
  };
}

/** The level the session runs at: YOLO for a session never moved. */
export function readSessionPermissionLevel(
  reader: Database,
  sessionId: SessionId,
): PermissionLevel {
  const row = reader
    .prepare<
      [string],
      { permissionLevel: PermissionLevel }
    >("SELECT permission_level AS permissionLevel FROM sessions WHERE id = ?")
    .get(sessionId);
  return row?.permissionLevel ?? "yolo";
}
