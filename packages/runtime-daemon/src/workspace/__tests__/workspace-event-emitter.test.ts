// Proves each workspace emit method appends one `session_lifecycle` row of its own type, carrying
// the schema-parsed payload and the state the method determines, with the envelope and payload fed
// from one sessionId and actor, and that a malformed payload is refused at the parse before
// anything is appended. Runs over a real database and event log.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  RepoWorkspaceLifecyclePayloadSchema,
  SESSION_EVENT_CATEGORY_BY_TYPE,
} from "@ai-sidekicks/contracts";
import type { SessionEventType } from "@ai-sidekicks/contracts";

import { EventLogService } from "../../events/event-log-service.js";
import { __resetSessionAppendLocksForTest } from "../../events/session-append-lock.js";
import { openDatabase } from "../../session/migration-runner.js";
import { WorkspaceEventEmitter } from "../workspace-event-emitter.js";

// The emission boundary validates the ids as UUIDs, so the fixtures must be real UUIDs.
const SESSION_ID: string = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f00";
const WORKSPACE_ID: string = "0190f8a2-2d4e-7f7b-9a32-3d8e7c5f0b21";
// `actor` is a free-form bounded string, not an id; any non-blank string is valid.
const USER_ID: string = "01J0PA0000NN5J5J5J5J5J5J5J";

// The `SessionEventType` annotation makes a name that leaves the registry fail compilation.
const WORKSPACE_LIFECYCLE_EVENT_TYPES: readonly SessionEventType[] = [
  "workspace.preparing",
  "workspace.ready",
  "workspace.stale",
  "workspace.archived",
];

// Raw row shape; no read model exposes `monotonic_ns`.
interface LifecycleRow {
  readonly sequence: bigint;
  readonly type: string;
  readonly category: string;
  readonly version: string;
  readonly actor: string | null;
  readonly occurred_at: string;
  readonly monotonic_ns: bigint;
  readonly payload: string;
}

function readRawRows(db: DatabaseType, sessionId: string): ReadonlyArray<LifecycleRow> {
  return db
    .prepare(
      `SELECT sequence, type, category, version, actor, occurred_at, monotonic_ns,
              payload
         FROM session_events
        WHERE session_id = ?
        ORDER BY sequence ASC`,
    )
    .safeIntegers(true)
    .all(sessionId) as ReadonlyArray<LifecycleRow>;
}

interface TestContext {
  db: DatabaseType;
  eventLog: EventLogService;
  tmpDir: string;
}

let ctx: TestContext;

beforeEach(() => {
  const tmpDir: string = mkdtempSync(join(tmpdir(), "ai-sidekicks-workspace-emitter-test-"));
  // No session row is seeded because `session_events.session_id` has no foreign key.
  const db: DatabaseType = openDatabase(join(tmpDir, "test.db"));
  ctx = { db, eventLog: new EventLogService({ db }), tmpDir };
});

afterEach(() => {
  // The per-session append lock is a module singleton; a queue entry left behind would stall the
  // next case on the same session id.
  __resetSessionAppendLocksForTest();
  if (ctx.db.open) {
    ctx.db.close();
  }
  rmSync(ctx.tmpDir, { recursive: true, force: true });
});

function makeEmitter(): WorkspaceEventEmitter {
  return new WorkspaceEventEmitter({ sessionEvents: ctx.eventLog });
}

/**
 * Reads back the single row an emit appended and asserts its type, category and version. The
 * category comes from the registry; the anchor test keeps that from being circular.
 */
function readSingleRow(expectedType: SessionEventType): LifecycleRow {
  const rows: ReadonlyArray<LifecycleRow> = readRawRows(ctx.db, SESSION_ID);
  expect(rows).toHaveLength(1);
  const row: LifecycleRow | undefined = rows[0];
  if (row === undefined) {
    throw new Error("expected exactly one persisted lifecycle row");
  }
  expect(row.type).toBe(expectedType);
  expect(row.category).toBe(SESSION_EVENT_CATEGORY_BY_TYPE.get(expectedType));
  expect(row.version).toBe("1.0");
  return row;
}

/** Asserts the persisted payload equals the expected literal and what the family schema returns. */
function expectPersistedPayload(row: LifecycleRow, expected: Record<string, unknown>): void {
  const persisted: Record<string, unknown> = JSON.parse(row.payload) as Record<string, unknown>;
  expect(persisted).toEqual(expected);
  expect(persisted).toEqual(RepoWorkspaceLifecyclePayloadSchema.parse(expected));
}

describe("WorkspaceEventEmitter — category registry anchor", () => {
  it("registers the four workspace lifecycle types under session_lifecycle", () => {
    expect(
      WORKSPACE_LIFECYCLE_EVENT_TYPES.map((type) => SESSION_EVENT_CATEGORY_BY_TYPE.get(type)),
    ).toEqual(["session_lifecycle", "session_lifecycle", "session_lifecycle", "session_lifecycle"]);
  });
});

describe("WorkspaceEventEmitter — per-event emission", () => {
  it("emitWorkspacePreparing appends one workspace.preparing row in state preparing", async () => {
    await makeEmitter().emitWorkspacePreparing({
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
    });

    expectPersistedPayload(readSingleRow("workspace.preparing"), {
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
      state: "preparing",
      // A system-driven transition: an absent actor becomes null on the wire.
      actor: null,
    });
  });

  it("emitWorkspaceReady appends one workspace.ready row in state ready", async () => {
    await makeEmitter().emitWorkspaceReady({
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
    });

    expectPersistedPayload(readSingleRow("workspace.ready"), {
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
      state: "ready",
      actor: null,
    });
  });

  it("emitWorkspaceStale appends one workspace.stale row in state stale", async () => {
    await makeEmitter().emitWorkspaceStale({
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
    });

    expectPersistedPayload(readSingleRow("workspace.stale"), {
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
      state: "stale",
      actor: null,
    });
  });

  it("emitWorkspaceArchived appends one workspace.archived row in state archived", async () => {
    await makeEmitter().emitWorkspaceArchived({
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
      actor: USER_ID,
    });

    expectPersistedPayload(readSingleRow("workspace.archived"), {
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
      state: "archived",
      actor: USER_ID,
    });
  });
});

describe("WorkspaceEventEmitter — envelope and payload agree", () => {
  it("populates the envelope and the payload from ONE sessionId and actor input", async () => {
    await makeEmitter().emitWorkspaceArchived({
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
      actor: USER_ID,
    });

    const row: LifecycleRow = readSingleRow("workspace.archived");
    const persisted: Record<string, unknown> = JSON.parse(row.payload) as Record<string, unknown>;
    // One input feeds both, so the row and its payload cannot disagree.
    expect(row.actor).toBe(USER_ID);
    expect(persisted["actor"]).toBe(USER_ID);
    expect(persisted["sessionId"]).toBe(SESSION_ID);
  });
});

describe("WorkspaceEventEmitter — emission-boundary rejection", () => {
  it("rejects a non-UUID workspaceId and appends nothing", async () => {
    await expect(
      makeEmitter().emitWorkspaceReady({
        sessionId: SESSION_ID,
        workspaceId: "workspace-1",
      }),
    ).rejects.toThrow();
    expect(readRawRows(ctx.db, SESSION_ID)).toHaveLength(0);
  });

  it("rejects a malformed sessionId and appends nothing", async () => {
    await expect(
      makeEmitter().emitWorkspacePreparing({
        sessionId: "session-1",
        workspaceId: WORKSPACE_ID,
      }),
    ).rejects.toThrow();
    expect(readRawRows(ctx.db, "session-1")).toHaveLength(0);
  });

  it("rejects an over-length actor and appends nothing", async () => {
    // 257 characters exceeds the 256-character cap, which matches the envelope's actor cap.
    await expect(
      makeEmitter().emitWorkspaceArchived({
        sessionId: SESSION_ID,
        workspaceId: WORKSPACE_ID,
        actor: "a".repeat(257),
      }),
    ).rejects.toThrow();
    expect(readRawRows(ctx.db, SESSION_ID)).toHaveLength(0);
  });
});
