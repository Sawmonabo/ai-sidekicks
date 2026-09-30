// WorktreeEventEmitter behavior.
//
// The emitter is the single seam every worktree state transition appends its `session_lifecycle`
// event through. Most cases run it over a real test SQLite database with `EventLogService` as the
// durable append path; the WorktreeEventLog seam block at the bottom uses plain-object logs for
// the parts of the contract a real database cannot show.
//
// Non-obvious points:
//   * The emitter reads `SESSION_EVENT_CATEGORY_BY_TYPE`, so the registry test pins that mapping
//     once; without it the per-event category assertions would only prove propagation.
//   * No emission carries `state: "failed"`, though the payload schema admits it. The schema side
//     is pinned in `packages/contracts/src/__tests__/worktree.test.ts`.
//   * Each method derives its own state, so there is no "rejects an out-of-vocabulary state"
//     case: it is unrepresentable, and a compile-time control pins that instead.
//   * A payload the family schema refuses makes the emit throw before the append, so nothing is
//     persisted. A missing `worktreeId` is refused at runtime by the emitter's own brand parse.
//   * The prelude is forwarded verbatim and never invoked by the emitter; a throwing prelude
//     aborts the real append before the INSERT.
//   * A synchronous append is refused twice: by the `Promise` return type (a `@ts-expect-error`
//     control) and by a runtime tripwire.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SESSION_EVENT_CATEGORY_BY_TYPE,
  WorktreeLifecyclePayloadSchema,
} from "@ai-sidekicks/contracts";
import type { SessionEventType, WorktreeState } from "@ai-sidekicks/contracts";

import { EventLogService } from "../../events/event-log-service.js";
import type {
  EventLogAppendReceipt,
  UnsequencedEventEnvelope,
} from "../../events/event-log-service.js";
import { __resetSessionAppendLocksForTest } from "../../events/session-append-lock.js";
import { openDatabase } from "../../session/migration-runner.js";
import { WorktreeEventEmitter } from "../worktree-event-emitter.js";
import type {
  EmitWorktreeEventInput,
  WorktreeEventEmitterDeps,
  WorktreeEventLog,
} from "../worktree-event-emitter.js";

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

// The five types this emitter owns. The `SessionEventType` annotation makes a type missing from
// the event registry fail compilation; `worktree.failed` is deliberately not a member.
const WORKTREE_EVENT_TYPES: readonly SessionEventType[] = [
  "worktree.created",
  "worktree.ready",
  "worktree.dirty",
  "worktree.merged",
  "worktree.retired",
];

// The type-to-state mapping restated independently of the emitter's private table, so a mis-keyed
// entry fails here. `failed` is absent from every row.
const STATE_TO_EVENT_MAPPING: ReadonlyArray<readonly [SessionEventType, WorktreeState]> = [
  ["worktree.created", "creating"],
  ["worktree.ready", "ready"],
  ["worktree.dirty", "dirty"],
  ["worktree.merged", "merged"],
  ["worktree.retired", "retired"],
];

// Raw read shape — `monotonic_ns` is not exposed by any read model.
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
function recordingEventLog(appended: UnsequencedEventEnvelope[]): WorktreeEventLog {
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
  // The per-session append lock is a module singleton; reset it between cases so a leftover queue
  // entry cannot stall the next case as an unrelated timeout.
  __resetSessionAppendLocksForTest();
  if (ctx.db.open) {
    ctx.db.close();
  }
  rmSync(ctx.tmpDir, { recursive: true, force: true });
});

function makeEmitter(overrides: Partial<WorktreeEventEmitterDeps> = {}): WorktreeEventEmitter {
  return new WorktreeEventEmitter({
    sessionEvents: ctx.eventLog,
    newEventId: makeCounterIdSource("evt"),
    ...overrides,
  });
}

/**
 * Reads the single row an emit appended and checks the envelope fields all five types share. The
 * category comes from the registry, which the anchor test pins.
 */
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
 * Asserts the persisted payload equals the expected literal and what the family schema returns
 * for it. The literal comparison catches missing, extra and wrong-state keys. The schema
 * comparison discriminates only on a non-canonical fixture (the padded-actor case): if a parser
 * starts normalizing, the literal comparison fails and the schema one names the value to persist.
 */
function expectPersistedPayload(row: LifecycleRow, expected: Record<string, unknown>): void {
  const persisted: Record<string, unknown> = JSON.parse(row.payload) as Record<string, unknown>;
  expect(persisted).toEqual(expected);
  expect(persisted).toEqual(WorktreeLifecyclePayloadSchema.parse(expected));
}

// ----------------------------------------------------------------------------
// Registry anchor — the fact every category assertion below leans on
// ----------------------------------------------------------------------------

describe("WorktreeEventEmitter — category registry anchor", () => {
  it("registers all five worktree lifecycle types under session_lifecycle", () => {
    expect(WORKTREE_EVENT_TYPES.map((type) => SESSION_EVENT_CATEGORY_BY_TYPE.get(type))).toEqual([
      "session_lifecycle",
      "session_lifecycle",
      "session_lifecycle",
      "session_lifecycle",
      "session_lifecycle",
    ]);
  });
});

// ----------------------------------------------------------------------------
// One method per event type
// ----------------------------------------------------------------------------

describe("WorktreeEventEmitter — per-event emission", () => {
  it("emitWorktreeCreated appends one worktree.created row in state creating", async () => {
    await makeEmitter().emitWorktreeCreated({
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
      actor: USER_ID,
    });

    expectPersistedPayload(readSingleRow("worktree.created"), {
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
      state: "creating",
      actor: USER_ID,
    });
  });

  it("emitWorktreeReady appends one worktree.ready row in state ready", async () => {
    await makeEmitter().emitWorktreeReady({
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
    });

    expectPersistedPayload(readSingleRow("worktree.ready"), {
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
      state: "ready",
      // A system-driven transition: an absent actor becomes null.
      actor: null,
    });
  });

  it("emitWorktreeDirty appends one worktree.dirty row in state dirty", async () => {
    await makeEmitter().emitWorktreeDirty({
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
    });

    expectPersistedPayload(readSingleRow("worktree.dirty"), {
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
      state: "dirty",
      actor: null,
    });
  });

  it("emitWorktreeMerged appends one worktree.merged row in state merged", async () => {
    await makeEmitter().emitWorktreeMerged({
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
    });

    expectPersistedPayload(readSingleRow("worktree.merged"), {
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
      state: "merged",
      actor: null,
    });
  });

  it("emitWorktreeRetired appends one worktree.retired row in state retired", async () => {
    await makeEmitter().emitWorktreeRetired({
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
      actor: USER_ID,
    });

    expectPersistedPayload(readSingleRow("worktree.retired"), {
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
      state: "retired",
      actor: USER_ID,
    });
  });

  it("takes no state from the caller — the method determines it", async () => {
    // Compile time: `state` is not a member of the input, so the literal is an excess property.
    // Deleting the directive must yield that error, not an unused-directive TS2578.
    await makeEmitter().emitWorktreeRetired({
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
      // @ts-expect-error — callers cannot pair a type with a state does not
      // give it.
      state: "dirty",
    });

    // Runtime: a state forced past the compiler is ignored; the persisted state is the one
    // `emitWorktreeRetired` owns.
    expectPersistedPayload(readSingleRow("worktree.retired"), {
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
      state: "retired",
      actor: null,
    });
  });

  it("persists a whitespace-padded actor VERBATIM — the family schema normalizes nothing", async () => {
    // The one non-canonical fixture; it keeps `expectPersistedPayload`'s literal-vs-parsed pair
    // discriminating. The actor regex needs one non-whitespace character and no parser trims, so
    // it persists verbatim; if a parser starts trimming, the literal comparison fails.
    await makeEmitter().emitWorktreeCreated({
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
      actor: "  alice  ",
    });

    expectPersistedPayload(readSingleRow("worktree.created"), {
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
      state: "creating",
      actor: "  alice  ",
    });
  });
});

// ----------------------------------------------------------------------------
// Mapping as a SET, and carve-out, emitter-side
// ----------------------------------------------------------------------------

describe("WorktreeEventEmitter — mapping and carve-out", () => {
  it("emits exactly the five mapped {type, state} pairs across all five methods", async () => {
    // Each per-event case proves one pairing against a persisted row; this proves the mapping as a
    // whole in one ordered comparison. A sixth method, a mis-keyed entry, or a method reusing
    // another's state fails here.
    // fails here even when every individual row still parses.
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

  it("never emits state `failed`, though the payload schema admits it", async () => {
    // `failed` is a `WorktreeState` and the payload schema parses it, so nothing downstream would
    // refuse a `worktree.retired` carrying it; the only guard is that no method here resolves to
    // that state. A failed preparation is evented as `workspace.stale` by `failRootPreparation`.
    const failedStatePayload = WorktreeLifecyclePayloadSchema.safeParse({
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
      state: "failed",
    });
    expect(failedStatePayload.success).toBe(true);

    const appended: UnsequencedEventEnvelope[] = [];
    const emitter: WorktreeEventEmitter = new WorktreeEventEmitter({
      sessionEvents: recordingEventLog(appended),
      newEventId: makeCounterIdSource("no-failed"),
    });
    const input: EmitWorktreeEventInput = { sessionId: SESSION_ID, worktreeId: WORKTREE_ID };

    await emitter.emitWorktreeCreated(input);
    await emitter.emitWorktreeReady(input);
    await emitter.emitWorktreeDirty(input);
    await emitter.emitWorktreeMerged(input);
    await emitter.emitWorktreeRetired(input);

    // Pin the count first: `not.toContain` passes on an empty array.
    expect(appended).toHaveLength(5);
    expect(appended.map(payloadState)).not.toContain("failed");
    expect(appended.map((envelope) => envelope.type)).not.toContain("worktree.failed");
  });
});

// ----------------------------------------------------------------------------
// monotonic_ns — forwarded by the emitter, persisted by the append path
// ----------------------------------------------------------------------------

describe("WorktreeEventEmitter — monotonic_ns and sequence", () => {
  it("persists the injected monotonic_ns", async () => {
    await makeEmitter({ monotonicNow: () => 11_000_000_000n }).emitWorktreeCreated({
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
    });

    const row: LifecycleRow = readSingleRow("worktree.created");
    expect(row.monotonic_ns).toBe(11_000_000_000n);
  });

  it("lets the append path allocate every sequence — successive emits advance it", async () => {
    const emitter: WorktreeEventEmitter = makeEmitter();
    const created: EventLogAppendReceipt = await emitter.emitWorktreeCreated({
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
    });
    const ready: EventLogAppendReceipt = await emitter.emitWorktreeReady({
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
    });

    // Receipts and rows both carry the sequences the append path assigned.
    expect([created.sequence, ready.sequence]).toEqual([0, 1]);
    expect(readRawRows(ctx.db, SESSION_ID).map((row) => row.sequence)).toEqual([0n, 1n]);
  });
});

// ----------------------------------------------------------------------------
// Envelope/payload reconciliation and subject identification
// ----------------------------------------------------------------------------

describe("WorktreeEventEmitter — envelope/payload reconciliation", () => {
  it("populates the envelope and the payload from ONE sessionId and actor input", async () => {
    await makeEmitter().emitWorktreeCreated({
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
      actor: USER_ID,
    });

    const row: LifecycleRow = readSingleRow("worktree.created");
    const persisted: Record<string, unknown> = JSON.parse(row.payload) as Record<string, unknown>;
    // The row's actor column is the payload's actor, and the row lives under the session the
    // payload names.
    expect(row.actor).toBe(USER_ID);
    expect(persisted["actor"]).toBe(USER_ID);
    expect(persisted["sessionId"]).toBe(SESSION_ID);
  });

  it("keeps the envelope-only linkage fields out of the payload", async () => {
    const appended: UnsequencedEventEnvelope[] = [];
    const emitter: WorktreeEventEmitter = new WorktreeEventEmitter({
      sessionEvents: recordingEventLog(appended),
    });
    await emitter.emitWorktreeRetired({
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
      correlationId: "corr-1",
      causationId: "cause-1",
    });

    const envelope: UnsequencedEventEnvelope | undefined = appended[0];
    expect(envelope?.correlationId).toBe("corr-1");
    expect(envelope?.causationId).toBe("cause-1");
    // The payload is the family shape only; correlation and causation are envelope linkage.
    expect(envelope?.payload).toEqual({
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
      state: "retired",
      actor: null,
    });
  });

  it("omits the correlation pair entirely when the caller supplies none", async () => {
    // Negative control: absent, not present-and-null, since `EventEnvelope` types the pair optional
    // and not nullable.
    const appended: UnsequencedEventEnvelope[] = [];
    const emitter: WorktreeEventEmitter = new WorktreeEventEmitter({
      sessionEvents: recordingEventLog(appended),
    });
    await emitter.emitWorktreeReady({ sessionId: SESSION_ID, worktreeId: WORKTREE_ID });

    const envelope: UnsequencedEventEnvelope | undefined = appended[0];
    expect(envelope).toBeDefined();
    expect(Object.hasOwn(envelope ?? {}, "correlationId")).toBe(false);
    expect(Object.hasOwn(envelope ?? {}, "causationId")).toBe(false);
  });

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

  it("omits the optional associations when the producer carries neither", async () => {
    // Negative control: a present-but-undefined key is as wrong as a populated one, since which ids
    // a payload carries is how a reader attributes the event.
    await makeEmitter().emitWorktreeDirty({
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
    });

    const row: LifecycleRow = readSingleRow("worktree.dirty");
    const persisted: Record<string, unknown> = JSON.parse(row.payload) as Record<string, unknown>;
    expect(Object.hasOwn(persisted, "repoMountId")).toBe(false);
    expect(Object.hasOwn(persisted, "workspaceId")).toBe(false);
    expect(persisted["worktreeId"]).toBe(WORKTREE_ID);
  });

  it("carries one association without inventing the other", async () => {
    // The worktree service's create seam holds `repoMountId` but no `workspaceId`, so this is the
    // shape its emissions take. The absent key must not be back-filled.
    // absent rather than being back-filled from anywhere.
    await makeEmitter().emitWorktreeCreated({
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
      repoMountId: REPO_MOUNT_ID,
    });

    const row: LifecycleRow = readSingleRow("worktree.created");
    const persisted: Record<string, unknown> = JSON.parse(row.payload) as Record<string, unknown>;
    expect(persisted["repoMountId"]).toBe(REPO_MOUNT_ID);
    expect(Object.hasOwn(persisted, "workspaceId")).toBe(false);
  });
});

// ----------------------------------------------------------------------------
// Emission boundary — the family schema's `.parse()` is a true gate
// ----------------------------------------------------------------------------
//
// Each case but the last is reachable with a type-valid input and asserts both the rejection and
// that nothing was persisted (a schema running after the append would fail the second half). The
// last forces a shape the interface forbids, to pin that `worktreeId` is refused at runtime.

describe("WorktreeEventEmitter — emission-boundary rejection", () => {
  it("rejects a non-UUID worktreeId and appends nothing", async () => {
    await expect(
      makeEmitter().emitWorktreeCreated({
        sessionId: SESSION_ID,
        worktreeId: "worktree-1",
      }),
    ).rejects.toThrow();
    expect(readRawRows(ctx.db, SESSION_ID)).toHaveLength(0);
  });

  it("rejects a non-UUID repoMountId and appends nothing", async () => {
    await expect(
      makeEmitter().emitWorktreeReady({
        sessionId: SESSION_ID,
        worktreeId: WORKTREE_ID,
        repoMountId: "not-a-uuid",
      }),
    ).rejects.toThrow();
    expect(readRawRows(ctx.db, SESSION_ID)).toHaveLength(0);
  });

  it("rejects a non-UUID workspaceId and appends nothing", async () => {
    await expect(
      makeEmitter().emitWorktreeMerged({
        sessionId: SESSION_ID,
        worktreeId: WORKTREE_ID,
        workspaceId: "workspace-1",
      }),
    ).rejects.toThrow();
    expect(readRawRows(ctx.db, SESSION_ID)).toHaveLength(0);
  });

  it("rejects a malformed sessionId and appends nothing", async () => {
    await expect(
      makeEmitter().emitWorktreeDirty({
        sessionId: "session-1",
        worktreeId: WORKTREE_ID,
      }),
    ).rejects.toThrow();
    expect(readRawRows(ctx.db, "session-1")).toHaveLength(0);
  });

  it("rejects a whitespace-only actor and appends nothing", async () => {
    // A blank actor is a producer bug, not a system actor (that is null or absent). Only
    // all-whitespace is blank; padding around content passes.
    // and the padded-actor arm above proves it persists verbatim.
    await expect(
      makeEmitter().emitWorktreeRetired({
        sessionId: SESSION_ID,
        worktreeId: WORKTREE_ID,
        actor: "   ",
      }),
    ).rejects.toThrow();
    expect(readRawRows(ctx.db, SESSION_ID)).toHaveLength(0);
  });

  it("rejects an over-length actor and appends nothing", async () => {
    // 257 chars trips the 256-char actor cap, the same bound the envelope's actor carries.
    // rejected one layer down.
    await expect(
      makeEmitter().emitWorktreeCreated({
        sessionId: SESSION_ID,
        worktreeId: WORKTREE_ID,
        actor: "a".repeat(257),
      }),
    ).rejects.toThrow();
    expect(readRawRows(ctx.db, SESSION_ID)).toHaveLength(0);
  });

  it("rejects a compiler-bypassed missing worktreeId and appends nothing", async () => {
    // The family schema types `worktreeId` optional, so this input parses clean there and would
    // persist a subjectless row. The emitter's own `WorktreeIdSchema.parse` refuses it; the cast
    // models a plain-JS producer.
    const subjectless = { sessionId: SESSION_ID } as unknown as EmitWorktreeEventInput;

    await expect(makeEmitter().emitWorktreeCreated(subjectless)).rejects.toThrow();
    expect(readRawRows(ctx.db, SESSION_ID)).toHaveLength(0);
  });
});

// ----------------------------------------------------------------------------
// Determinism — injected clock + id flow through to the persisted row
// ----------------------------------------------------------------------------

describe("WorktreeEventEmitter — determinism (injected monotonicNow/now/newEventId)", () => {
  it("flows injected monotonicNow, now, and newEventId through to the persisted row", async () => {
    // Canonical RFC 3339 UTC milliseconds: the append path normalizes other timestamps, so only a
    // canonical fixture proves the injected value flowed through verbatim.
    // value flowed through verbatim.
    const FIXED_MONOTONIC: bigint = 8_484_000_000n;
    const FIXED_OCCURRED_AT: string = "2026-08-05T10:30:00.000Z";
    const FIXED_EVENT_ID: string = "evt-worktree-deterministic-0";

    const emitter: WorktreeEventEmitter = new WorktreeEventEmitter({
      sessionEvents: ctx.eventLog,
      monotonicNow: () => FIXED_MONOTONIC,
      now: () => FIXED_OCCURRED_AT,
      newEventId: () => FIXED_EVENT_ID,
    });

    const returned: EventLogAppendReceipt = await emitter.emitWorktreeCreated({
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
    });

    // The receipt echoes the injected id; the clocks are asserted on the persisted row. An emitter
    // calling the production sources directly would pass every other case.
    // other arm in this file; this one is what fails.
    expect(returned.id).toBe(FIXED_EVENT_ID);

    const row: LifecycleRow = readSingleRow("worktree.created");
    expect(row.monotonic_ns).toBe(FIXED_MONOTONIC);
    expect(row.occurred_at).toBe(FIXED_OCCURRED_AT);
  });

  it("defaults newEventId to a unique-per-emit source so successive emits do not collide on the PRIMARY KEY", async () => {
    // No `newEventId` override, so the production `mintUuidV7` default applies. A constant id
    // would collide on the `TEXT PRIMARY KEY`.
    const emitter: WorktreeEventEmitter = new WorktreeEventEmitter({
      sessionEvents: ctx.eventLog,
    });

    const first: EventLogAppendReceipt = await emitter.emitWorktreeCreated({
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
    });
    const second: EventLogAppendReceipt = await emitter.emitWorktreeReady({
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
    });

    expect(first.id).not.toBe(second.id);
    expect(readRawRows(ctx.db, SESSION_ID)).toHaveLength(2);
  });
});

// ----------------------------------------------------------------------------
// WorktreeEventLog seam — plain-object logs, plus one real-append case (prelude abort)
// ----------------------------------------------------------------------------

describe("WorktreeEventEmitter — WorktreeEventLog seam", () => {
  it("emits through a plain-object log implementation (no EventLogService, no database)", async () => {
    const appended: UnsequencedEventEnvelope[] = [];
    const emitter: WorktreeEventEmitter = new WorktreeEventEmitter({
      sessionEvents: recordingEventLog(appended),
      newEventId: makeCounterIdSource("structural"),
    });

    const created: EventLogAppendReceipt = await emitter.emitWorktreeCreated({
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
    });
    const ready: EventLogAppendReceipt = await emitter.emitWorktreeReady({
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
    });

    expect(appended).toHaveLength(2);
    expect(appended[0]?.type).toBe("worktree.created");
    expect(appended[1]?.type).toBe("worktree.ready");
    // The seam's sequences are surfaced verbatim.
    expect([created.sequence, ready.sequence]).toEqual([0, 1]);
  });

  it("forwards a caller-supplied transactionalPrelude verbatim and never runs it", async () => {
    // The emitter must forward the prelude untouched and never invoke it: invoking would apply the
    // producer's row write a second time, outside the append transaction. The capturing log never
    // runs what it captures, so a nonzero count means the emitter ran it.
    const forwardedOptions: Array<{ transactionalPrelude?: () => void }> = [];
    const capturingEventLog: WorktreeEventLog = {
      append: (envelope, options) => {
        forwardedOptions.push(options ?? {});
        return Promise.resolve({ id: envelope.id, sequence: 0 });
      },
    };
    let preludeInvocations: number = 0;
    const prelude = (): void => {
      preludeInvocations += 1;
    };

    await new WorktreeEventEmitter({ sessionEvents: capturingEventLog }).emitWorktreeCreated({
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
      transactionalPrelude: prelude,
    });

    expect(forwardedOptions).toHaveLength(1);
    expect(forwardedOptions[0]?.transactionalPrelude).toBe(prelude);
    expect(preludeInvocations).toBe(0);
  });

  it("omits transactionalPrelude entirely when the caller supplies none", async () => {
    // Negative control: the key is absent, not present-and-undefined.
    const forwardedOptions: Array<Record<string, unknown>> = [];
    const capturingEventLog: WorktreeEventLog = {
      append: (envelope, options) => {
        forwardedOptions.push((options ?? {}) as Record<string, unknown>);
        return Promise.resolve({ id: envelope.id, sequence: 0 });
      },
    };

    await new WorktreeEventEmitter({ sessionEvents: capturingEventLog }).emitWorktreeCreated({
      sessionId: SESSION_ID,
      worktreeId: WORKTREE_ID,
    });

    expect(forwardedOptions[0]).toBeDefined();
    expect(Object.hasOwn(forwardedOptions[0] ?? {}, "transactionalPrelude")).toBe(false);
  });

  it("aborts the append when the forwarded prelude throws against the real path — no row persists", async () => {
    // Against the real append path the prelude runs inside the transaction, so its throw aborts
    // before the INSERT and reaches the producer. An emitter that swallowed the rejection, or whose
    // forwarding missed the transaction boundary, passes the identity cases and fails here.
    await expect(
      makeEmitter().emitWorktreeCreated({
        sessionId: SESSION_ID,
        worktreeId: WORKTREE_ID,
        transactionalPrelude: () => {
          throw new Error("prelude divergence");
        },
      }),
    ).rejects.toThrow("prelude divergence");
    expect(readRawRows(ctx.db, SESSION_ID)).toHaveLength(0);
  });

  it("rejects a synchronous append at COMPILE time (Promise return, not undefined)", async () => {
    // `undefined` is not assignable to `Promise<EventLogAppendReceipt>`. Deleting the directive
    // must yield that assignment error; an unused-directive TS2578 would mean the compile-time
    // layer regressed.
    const compileRejectedEventLog: WorktreeEventLog = {
      // @ts-expect-error — a synchronous `append` (returns `undefined`) does not
      // satisfy `append(envelope, options): Promise<EventLogAppendReceipt>`.
      append: (): undefined => undefined,
    };
    // The object still exists at runtime; the runtime tripwire covers it.
    await expect(
      new WorktreeEventEmitter({ sessionEvents: compileRejectedEventLog }).emitWorktreeCreated({
        sessionId: SESSION_ID,
        worktreeId: WORKTREE_ID,
      }),
    ).rejects.toThrow(/did not return a promise/);
  });

  it("refuses a non-thenable append fail-closed", async () => {
    // The seam is async-transactional by contract: a synchronous append would report success before
    // the write is durable and never commit the prelude atomically with the row. Reaching the
    // runtime tripwire needs wiring the compiler never saw, which the cast models.
    const appendCalls: UnsequencedEventEnvelope[] = [];
    const syncEventLog: WorktreeEventLog = {
      append: (envelope): Promise<EventLogAppendReceipt> => {
        appendCalls.push(envelope);
        return undefined as unknown as Promise<EventLogAppendReceipt>;
      },
    };

    await expect(
      new WorktreeEventEmitter({ sessionEvents: syncEventLog }).emitWorktreeCreated({
        sessionId: SESSION_ID,
        worktreeId: WORKTREE_ID,
      }),
    ).rejects.toThrow(/did not return a promise[\s\S]*transactionalPrelude/);

    // A tripwire, not prevention: the append has already run when the non-promise comes back.
    expect(appendCalls).toHaveLength(1);
  });

  it("admits a custom thenable (duck-typed, not instanceof Promise)", async () => {
    // Positive control for the duck test: `await` accepts any `then` function, so the guard must
    // too. An `instanceof Promise` check would wrongly reject a userland promise, and every other
    // case returns real Promises and would stay green.
    const receipt: EventLogAppendReceipt = { id: "x", sequence: 3 };
    const customThenableEventLog: WorktreeEventLog = {
      append: (): Promise<EventLogAppendReceipt> =>
        ({
          then: (resolve?: (value: EventLogAppendReceipt) => void) => resolve?.(receipt),
        }) as unknown as Promise<EventLogAppendReceipt>,
    };

    await expect(
      new WorktreeEventEmitter({ sessionEvents: customThenableEventLog }).emitWorktreeCreated({
        sessionId: SESSION_ID,
        worktreeId: WORKTREE_ID,
      }),
    ).resolves.toEqual(receipt);
  });

  it("propagates a REJECTING append unchanged", async () => {
    // The producer learns its durable write failed from this rejection; the emitter awaits, so it
    // arrives verbatim.
    const rejectingEventLog: WorktreeEventLog = {
      append: (): Promise<EventLogAppendReceipt> => Promise.reject(new Error("append lock lost")),
    };

    await expect(
      new WorktreeEventEmitter({ sessionEvents: rejectingEventLog }).emitWorktreeCreated({
        sessionId: SESSION_ID,
        worktreeId: WORKTREE_ID,
      }),
    ).rejects.toThrow("append lock lost");
  });
});
