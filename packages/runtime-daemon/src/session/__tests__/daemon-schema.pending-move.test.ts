// A session's pending working-folder move is a flag and an optional worktree, which the session
// read takes on trust: the worktree is read only while a move is pending, so the schema refuses a
// worktree with no move pending and a flag that is neither set nor clear.

import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "../migration-runner.js";

const TIMESTAMP = "2026-10-06T00:00:00.000Z";
const CHECK_FAILURE = /CHECK constraint failed/;

describe("a session's pending working-folder move", () => {
  let db: DatabaseType;
  let nextId = 0;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  function insertSession(pendingMove: number, pendingWorktreeId: string | null): void {
    nextId += 1;
    db.prepare(
      `INSERT INTO sessions
         (id, shape, state, pending_move, pending_worktree_id,
          created_at, updated_at, last_activity_at)
       VALUES (?, 'project', 'active', ?, ?, ?, ?, ?)`,
    ).run(
      `session-${String(nextId)}`,
      pendingMove,
      pendingWorktreeId,
      TIMESTAMP,
      TIMESTAMP,
      TIMESTAMP,
    );
  }

  it("names a worktree only while a move is pending, and is either pending or not", () => {
    // A pending move with no worktree targets the project's own checkout.
    expect(() => insertSession(1, null)).not.toThrow();
    expect(() => insertSession(1, "worktree-1")).not.toThrow();
    expect(() => insertSession(0, "worktree-1")).toThrow(CHECK_FAILURE);
    expect(() => insertSession(2, null)).toThrow(CHECK_FAILURE);
  });
});
