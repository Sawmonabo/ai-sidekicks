// Every member of a contract union is admitted by the SQLite CHECK on the session directory column
// that stores it, and a value outside it is refused. The `Record<Union, true>` member maps make a
// contract member added without an accept case a typecheck error here.

import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SessionLinkKind } from "@ai-sidekicks/contracts/session/links";
import type { SessionShape, SessionState } from "@ai-sidekicks/contracts/session/methods";

import { openDatabase } from "../migration-runner.js";
import type { LiveRunActivity, SessionRunOutcome } from "../records.js";

const TIMESTAMP = "2026-10-06T00:00:00.000Z";
const NON_MEMBER = "not-a-member";
const CHECK_FAILURE = /CHECK constraint failed/;

const SESSION_SHAPES: Record<SessionShape, true> = { chat: true, project: true };
const SESSION_STATES: Record<SessionState, true> = {
  provisioning: true,
  active: true,
  archived: true,
  closed: true,
  purge_requested: true,
};
const RUN_OUTCOMES: Record<SessionRunOutcome, true> = { done: true, failed: true, idle: true };
const LIVE_RUN_ACTIVITIES: Record<LiveRunActivity, true> = { running: true, waiting: true };
const LINK_KINDS: Record<SessionLinkKind, true> = {
  started: true,
  copied_from: true,
  messaged: true,
  asked: true,
  mentioned: true,
  related: true,
};

function membersOf<Member extends string>(members: Record<Member, true>): Member[] {
  return Object.keys(members) as Member[];
}

describe("session directory constraints", () => {
  let db: DatabaseType;
  let nextId = 0;
  const newId = (prefix: string): string => `${prefix}-${(nextId += 1)}`;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  // A valid row; each test overrides the one column it checks.
  function insertSession(
    overrides: {
      shape?: string;
      state?: string;
      lastRunOutcome?: string;
      documentCount?: number;
      pendingMove?: number;
      pendingWorktreeId?: string | null;
    } = {},
  ): void {
    db.prepare(
      `INSERT INTO sessions
         (id, shape, state, last_run_outcome, document_count, pending_move, pending_worktree_id,
          created_at, updated_at, last_activity_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      newId("session"),
      overrides.shape ?? "chat",
      overrides.state ?? "active",
      overrides.lastRunOutcome ?? "idle",
      overrides.documentCount ?? 0,
      overrides.pendingMove ?? 0,
      overrides.pendingWorktreeId ?? null,
      TIMESTAMP,
      TIMESTAMP,
      TIMESTAMP,
    );
  }

  it("admits every session shape, state and run outcome, and refuses any other", () => {
    for (const shape of membersOf(SESSION_SHAPES)) {
      expect(() => insertSession({ shape })).not.toThrow();
    }
    for (const state of membersOf(SESSION_STATES)) {
      expect(() => insertSession({ state })).not.toThrow();
    }
    for (const lastRunOutcome of membersOf(RUN_OUTCOMES)) {
      expect(() => insertSession({ lastRunOutcome })).not.toThrow();
    }
    expect(() => insertSession({ shape: NON_MEMBER })).toThrow(CHECK_FAILURE);
    expect(() => insertSession({ state: NON_MEMBER })).toThrow(CHECK_FAILURE);
    // A live reading is never a run's outcome.
    expect(() => insertSession({ lastRunOutcome: "running" })).toThrow(CHECK_FAILURE);
  });

  it("names a worktree for a pending move only while one is pending", () => {
    // A pending move with no worktree targets the project's own checkout.
    expect(() => insertSession({ pendingMove: 1 })).not.toThrow();
    expect(() => insertSession({ pendingMove: 1, pendingWorktreeId: "worktree-1" })).not.toThrow();
    expect(() => insertSession({ pendingWorktreeId: "worktree-1" })).toThrow(CHECK_FAILURE);
    expect(() => insertSession({ pendingMove: 2 })).toThrow(CHECK_FAILURE);
    expect(() => insertSession({ documentCount: -1 })).toThrow(CHECK_FAILURE);
  });

  it("admits every live run activity and refuses any other", () => {
    const insertRun = db.prepare(
      `INSERT INTO session_run_activity (session_id, run_id, activity) VALUES ('session-1', ?, ?)`,
    );
    for (const activity of membersOf(LIVE_RUN_ACTIVITIES)) {
      expect(() => insertRun.run(newId("run"), activity)).not.toThrow();
    }
    expect(() => insertRun.run(newId("run"), "done")).toThrow(CHECK_FAILURE);
  });

  it("bounds a session's own step limit from below at one, and lets it be unset", () => {
    const insertConsoleState = db.prepare(
      `INSERT INTO session_console_state (session_id, max_steps_per_turn, updated_at)
       VALUES (?, ?, ?)`,
    );
    expect(() => insertConsoleState.run(newId("session"), null, TIMESTAMP)).not.toThrow();
    expect(() => insertConsoleState.run(newId("session"), 1, TIMESTAMP)).not.toThrow();
    expect(() => insertConsoleState.run(newId("session"), 0, TIMESTAMP)).toThrow(CHECK_FAILURE);
  });

  it("admits every link kind with a use count of at least one, and refuses any other", () => {
    const insertLink = db.prepare(
      `INSERT INTO session_links
         (source_session_id, target_session_id, kind, use_count, first_at, last_at)
       VALUES ('session-1', ?, ?, ?, ?, ?)`,
    );
    for (const kind of membersOf(LINK_KINDS)) {
      expect(() => insertLink.run(newId("session"), kind, 1, TIMESTAMP, TIMESTAMP)).not.toThrow();
    }
    expect(() => insertLink.run(newId("session"), NON_MEMBER, 1, TIMESTAMP, TIMESTAMP)).toThrow(
      CHECK_FAILURE,
    );
    expect(() => insertLink.run(newId("session"), "related", 0, TIMESTAMP, TIMESTAMP)).toThrow(
      CHECK_FAILURE,
    );
  });
});
