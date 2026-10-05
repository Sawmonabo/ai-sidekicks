// The worktree lifecycle events a client reads: each method's type and state, the subject ids a
// payload carries, and the refusal that keeps a subjectless event out of the log.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SESSION_EVENT_CATEGORY_BY_TYPE } from "@ai-sidekicks/contracts/event/session-event";
import { WorktreeLifecyclePayloadSchema } from "@ai-sidekicks/contracts/worktree/worktree";
import type { SessionEventType } from "@ai-sidekicks/contracts/event/registry";
import type { WorktreeState } from "@ai-sidekicks/contracts/worktree/worktree";

import { EventLogService } from "../../events/event-log-service.js";
import type { UnsequencedEventEnvelope } from "../../events/event-log-service.js";
import { openDatabase } from "../../session/migration-runner.js";
import { WorktreeEventEmitter } from "../worktree-event-emitter.js";
import type { EmitWorktreeEventInput } from "../worktree-event-emitter.js";
import type { LifecycleEventLog } from "../../workspace/lifecycle-event-appender.js";

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

// All four ids are parsed as branded UUIDs at the emission boundary, so fixtures are real UUIDs.
const SESSION_ID: string = "0190f8b0-7e2d-7c4a-9b1c-1b7c5b3e8f00";
const WORKTREE_ID: string = "0190f8b1-1c3d-7e6a-8f21-2c7d6b4e9a10";
const REPO_MOUNT_ID: string = "0190f8b2-2d4e-7f7b-9a32-3d8e7c5f0b21";
const WORKSPACE_ID: string = "0190f8b3-3e5f-7a8c-8b43-4e9f8d60c132";
// `actor` is a free-form bounded string, not a branded id.
const USER_ID: string = "01J0PA0000NN5J5J5J5J5J5J5J";

// The type-to-state mapping restated independently of the emitter's private table, so a mis-keyed
// entry fails here. `failed` is absent from every row.
const STATE_TO_EVENT_MAPPING: ReadonlyArray<readonly [SessionEventType, WorktreeState]> = [
  ["worktree.created", "creating"],
  ["worktree.ready", "ready"],
  ["worktree.dirty", "dirty"],
  ["worktree.merged", "merged"],
  ["worktree.retired", "retired"],
];

interface LifecycleRow {
  readonly type: string;
  readonly category: string;
  readonly version: string;
  readonly payload: string;
}

function readRawRows(db: DatabaseType, sessionId: string): ReadonlyArray<LifecycleRow> {
  return db
    .prepare(
      `SELECT type, category, version, payload
         FROM session_events
        WHERE session_id = ?
        ORDER BY sequence ASC`,
    )
    .all(sessionId) as ReadonlyArray<LifecycleRow>;
}

// Deterministic, collision-free id source: a constant id would violate the `TEXT PRIMARY KEY`.
function makeCounterIdSource(prefix: string): () => string {
  let counter: number = 0;
  return () => `${prefix}-${(counter++).toString()}`;
}

/**
 * The `state` an envelope's payload carries. The envelope types `payload` as
 * `Record<string, unknown>`, so reading it needs one narrow.
 */
function payloadState(envelope: UnsequencedEventEnvelope): unknown {
  return (envelope.payload as { state?: unknown }).state;
}

/**
 * A plain-object append seam that records the envelopes it is handed. It proves the emitter names
 * no concrete storage class and shows envelope facts SQL cannot (the correlation pair's absence).
 */
function recordingEventLog(appended: UnsequencedEventEnvelope[]): LifecycleEventLog {
  return {
    append: (envelope) => {
      appended.push(envelope);
      return Promise.resolve({
        id: envelope.id,
        sequence: appended.length - 1,
      });
    },
  };
}

// ----------------------------------------------------------------------------
// Per-test database lifecycle
// ----------------------------------------------------------------------------

interface TestContext {
  db: DatabaseType;
  eventLog: EventLogService;
  tmpDir: string;
}

let ctx: TestContext;

beforeEach(() => {
  const tmpDir: string = mkdtempSync(join(tmpdir(), "ai-sidekicks-worktree-emitter-test-"));
  const dbPath: string = join(tmpDir, "test.db");
  // Canonical factory, so pragmas and migrations match production. `session_events` has no foreign
  // key to sessions or worktrees, so no rows are seeded.
  const db: DatabaseType = openDatabase(dbPath);
  ctx = {
    db,
    eventLog: new EventLogService({
      db,
    }),
    tmpDir,
  };
});

afterEach(() => {
  if (ctx.db.open) {
    ctx.db.close();
  }
  rmSync(ctx.tmpDir, { recursive: true, force: true });
});

function makeEmitter(): WorktreeEventEmitter {
  return new WorktreeEventEmitter({
    sessionEvents: ctx.eventLog,
    newEventId: makeCounterIdSource("evt"),
  });
}

/** Reads the single row an emit appended and checks the envelope fields all five types share. */
function readSingleRow(expectedType: SessionEventType): LifecycleRow {
  const rows: ReadonlyArray<LifecycleRow> = readRawRows(ctx.db, SESSION_ID);
  expect(rows).toHaveLength(1);
  const row: LifecycleRow | undefined = rows[0];
  if (row === undefined) {
    throw new Error("expected exactly one persisted worktree lifecycle row");
  }
  expect(row.type).toBe(expectedType);
  expect(row.category).toBe(SESSION_EVENT_CATEGORY_BY_TYPE.get(expectedType));
  expect(row.version).toBe("1.0");
  return row;
}

/**
 * Asserts the persisted payload equals the expected literal, which catches missing, extra and
 * wrong-state keys, and equals what the lifecycle payload schema returns for it.
 */
function expectPersistedPayload(row: LifecycleRow, expected: Record<string, unknown>): void {
  const persisted: Record<string, unknown> = JSON.parse(row.payload) as Record<string, unknown>;
  expect(persisted).toEqual(expected);
  expect(persisted).toEqual(WorktreeLifecyclePayloadSchema.parse(expected));
}

// ----------------------------------------------------------------------------
// The type-to-state mapping
// ----------------------------------------------------------------------------

describe("WorktreeEventEmitter — type-to-state mapping", () => {
  it("emits exactly the five mapped {type, state} pairs across all five methods", async () => {
    // One ordered comparison over all five methods: a sixth method, a mis-keyed entry, or a method
    // reusing another's state fails here even when every row still parses.
    const appended: UnsequencedEventEnvelope[] = [];
    const emitter: WorktreeEventEmitter = new WorktreeEventEmitter({
      sessionEvents: recordingEventLog(appended),
      newEventId: makeCounterIdSource("mapping"),
    });
    // Annotated, not inferred, so excess-property checking refuses a stray key (a hand-supplied
    // `state`, say).
    const input: EmitWorktreeEventInput = { sessionId: SESSION_ID, worktreeId: WORKTREE_ID };

    await emitter.emitWorktreeCreated(input);
    await emitter.emitWorktreeReady(input);
    await emitter.emitWorktreeDirty(input);
    await emitter.emitWorktreeMerged(input);
    await emitter.emitWorktreeRetired(input);

    const emittedPairs = appended.map((envelope) => [envelope.type, payloadState(envelope)]);
    expect(emittedPairs).toEqual(STATE_TO_EVENT_MAPPING);
  });
});

// ----------------------------------------------------------------------------
// Subject ids
// ----------------------------------------------------------------------------

describe("WorktreeEventEmitter — subject ids", () => {
  it("names the full subject context when the producer carries it", async () => {
    // The worktree id plus the mount the checkout belongs to and the workspace its root serves.
    // Multi-id is legitimate, so the payload has no "exactly one id" refinement.
    await makeEmitter().emitWorktreeReady({
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
      repoMountId: REPO_MOUNT_ID,
      workspaceId: WORKSPACE_ID,
      actor: USER_ID,
    });

    expectPersistedPayload(readSingleRow("worktree.ready"), {
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
      repoMountId: REPO_MOUNT_ID,
      workspaceId: WORKSPACE_ID,
      state: "ready",
      actor: USER_ID,
    });
  });
});

// ----------------------------------------------------------------------------
// Refusal before the append
// ----------------------------------------------------------------------------

describe("WorktreeEventEmitter — emission-boundary rejection", () => {
  it("rejects a compiler-bypassed missing worktreeId and appends nothing", async () => {
    // The lifecycle payload schema types `worktreeId` optional, so this input parses clean there
    // and would persist a subjectless row. The emitter's own `WorktreeIdSchema.parse` refuses it;
    // the cast models a plain-JS producer.
    const subjectless = { sessionId: SESSION_ID } as unknown as EmitWorktreeEventInput;

    await expect(makeEmitter().emitWorktreeCreated(subjectless)).rejects.toThrow();
    expect(readRawRows(ctx.db, SESSION_ID)).toHaveLength(0);
  });
});
