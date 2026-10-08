// A rebuild through the directory projection writes back the `sessions` row the live writes
// wrote, over the same row, so its rowid and its group stay, and writes a row the database lost
// again from the session's log.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import { ProjectionRebuildService } from "../../../recovery/projection-rebuild.js";
import { mintUuidV7 } from "../../../uuid-v7.js";
import { SessionService } from "../../service.js";
import { mintSessionId } from "../__fixtures__/directory-rows.js";
import { openSessionLog, type SessionLog } from "../__fixtures__/event-log.js";
import { SESSION_DIRECTORY_PROJECTION } from "../projection.js";

let log: SessionLog;
let rebuild: ProjectionRebuildService;

beforeEach(async () => {
  log = await openSessionLog();
  rebuild = new ProjectionRebuildService({
    reader: log.scratch.reader,
    writer: log.scratch.writer,
    sessionEvents: new SessionService(log.scratch.reader),
    projections: [SESSION_DIRECTORY_PROJECTION],
  });
});

afterEach(async () => {
  await log.scratch.close();
});

function readRow(sessionId: SessionId): Record<string, unknown> | undefined {
  return log.scratch.reader.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as
    | Record<string, unknown>
    | undefined;
}

function readRowid(sessionId: SessionId): unknown {
  return log.scratch.reader
    .prepare("SELECT rowid FROM sessions WHERE id = ?")
    .pluck()
    .get(sessionId);
}

async function createNamedSession(name: string): Promise<SessionId> {
  const sessionId = mintSessionId();
  await log.createSession(sessionId, "project");
  await log.append(sessionId, "user.message", "interactive_request", {
    sessionId,
    actor: "user-1",
    message: "fix the login redirect",
  });
  await log.append(sessionId, "session.renamed", "session_lifecycle", {
    sessionId,
    name,
    origin: "user",
  });
  await log.append(sessionId, "session.pinned", "session_lifecycle", {
    sessionId,
    at: "2026-10-06T12:05:00.000Z",
  });
  return sessionId;
}

describe("the session directory projection", () => {
  it("rebuilds a row in place, keeping what services wrote, and a lost row again", async () => {
    const kept = await createNamedSession("Login fix");
    const lost = await createNamedSession("Release notes");
    const groupId = mintUuidV7();
    await log.scratch.writer.write([
      {
        sql: `INSERT INTO session_groups (id, project_id, name, name_folded, created_at)
              VALUES (?, ?, 'Auth', 'auth', '2026-10-06T12:00:00.000Z')`,
        bindings: [groupId, mintUuidV7()],
      },
      {
        sql: "UPDATE sessions SET group_id = ? WHERE id = ?",
        bindings: [groupId, kept],
        expectedRowCount: 1,
      },
    ]);
    const keptRow = readRow(kept);
    const keptRowid = readRowid(kept);
    const lostRow = readRow(lost);
    await log.scratch.writer.write([
      {
        sql: "UPDATE sessions SET name = 'stale', last_run_outcome = 'failed' WHERE id = ?",
        bindings: [kept],
        expectedRowCount: 1,
      },
      { sql: "DELETE FROM sessions WHERE id = ?", bindings: [lost], expectedRowCount: 1 },
    ]);

    await rebuild.rebuild({ sessionId: kept, force: true });
    await rebuild.rebuild({ sessionId: lost, force: true });

    expect(readRow(kept)).toStrictEqual(keptRow);
    expect(readRowid(kept)).toBe(keptRowid);
    expect(readRow(lost)).toStrictEqual(lostRow);
  });
});
