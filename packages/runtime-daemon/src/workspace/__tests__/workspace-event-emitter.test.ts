// The emitter is the single seam every repo-mount and workspace state transition appends its
// `session_lifecycle` event through. These tests run it over a real SQLite database with
// `EventLogService` as the durable append path; the last block drives it through plain-object logs
// to pin the parts of the seam contract a real database cannot show.
//
// The registry anchor test pins `SESSION_EVENT_CATEGORY_BY_TYPE` once, so the per-event category
// assertions, which read the same registry, are not circular.
//
// There is no "rejects an out-of-vocabulary state" test: each method derives its own state, so the
// case cannot be written, and a `@ts-expect-error` control pins that. The state vocabulary itself
// belongs to the contracts tests.

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
import type {
  EventLogAppendReceipt,
  UnsequencedEventEnvelope,
} from "../../events/event-log-service.js";
import { __resetSessionAppendLocksForTest } from "../../events/session-append-lock.js";
import { openDatabase } from "../../session/migration-runner.js";
import { WorkspaceEventEmitter } from "../workspace-event-emitter.js";
import type { WorkspaceEventEmitterDeps, WorkspaceEventLog } from "../workspace-event-emitter.js";

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

// The emission boundary validates all three ids as UUIDs, so the fixtures must be real UUIDs.
const SESSION_ID: string = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f00";
const REPO_MOUNT_ID: string = "0190f8a1-1c3d-7e6a-8f21-2c7d6b4e9a10";
const WORKSPACE_ID: string = "0190f8a2-2d4e-7f7b-9a32-3d8e7c5f0b21";
// `actor` is a free-form bounded string, not an id; any non-blank string is valid.
const USER_ID: string = "01J0PA0000NN5J5J5J5J5J5J5J";

// The six types this emitter owns. The `SessionEventType` annotation makes a name that leaves the
// registry fail compilation instead of asserting against nothing.
const LIFECYCLE_EVENT_TYPES: readonly SessionEventType[] = [
  "repo.attached",
  "repo.detached",
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

// A constant id would violate the `TEXT PRIMARY KEY` on the second emit, so tests that emit more
// than once inject this counter.
function makeCounterIdSource(prefix: string): () => string {
  let counter: number = 0;
  return () => `${prefix}-${(counter++).toString()}`;
}

/**
 * A plain-object append seam that records each envelope and returns its own receipt. It shows the
 * emitter needs no concrete storage class, and exposes envelope facts SQL cannot, such as the
 * absence of the correlation pair.
 */
function recordingEventLog(appended: UnsequencedEventEnvelope[]): WorkspaceEventLog {
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
  const tmpDir: string = mkdtempSync(join(tmpdir(), "ai-sidekicks-workspace-emitter-test-"));
  const dbPath: string = join(tmpDir, "test.db");
  // The production factory (pragmas and migrations). No session row is seeded because
  // `session_events.session_id` has no foreign key.
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
  // The per-session append lock is a module singleton; a queue entry left behind would stall the
  // next case on the same session id and surface as an unrelated timeout.
  __resetSessionAppendLocksForTest();
  if (ctx.db.open) {
    ctx.db.close();
  }
  rmSync(ctx.tmpDir, { recursive: true, force: true });
});

function makeEmitter(overrides: Partial<WorkspaceEventEmitterDeps> = {}): WorkspaceEventEmitter {
  return new WorkspaceEventEmitter({
    sessionEvents: ctx.eventLog,
    newEventId: makeCounterIdSource("evt"),
    ...overrides,
  });
}

/**
 * Reads back the single row an emit appended and asserts the envelope fields all six types carry.
 * The category comes from the registry; the anchor test above keeps that from being circular.
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

/**
 * Asserts the persisted payload equals both the expected literal and what the family schema
 * returns for it. The literal comparison catches a missing or extra key, such as an envelope-only
 * field leaking into the payload. The schema comparison only discriminates for a non-canonical
 * input, which the whitespace-padded-actor test supplies: if a parser starts normalizing, the
 * literal comparison fails there and the schema comparison shows the value to persist.
 */
function expectPersistedPayload(row: LifecycleRow, expected: Record<string, unknown>): void {
  const persisted: Record<string, unknown> = JSON.parse(row.payload) as Record<string, unknown>;
  expect(persisted).toEqual(expected);
  expect(persisted).toEqual(RepoWorkspaceLifecyclePayloadSchema.parse(expected));
}

// ----------------------------------------------------------------------------
// Registry anchor
// ----------------------------------------------------------------------------

describe("WorkspaceEventEmitter — category registry anchor", () => {
  it("registers all six repo-mount / workspace lifecycle types under session_lifecycle", () => {
    expect(LIFECYCLE_EVENT_TYPES.map((type) => SESSION_EVENT_CATEGORY_BY_TYPE.get(type))).toEqual([
      "session_lifecycle",
      "session_lifecycle",
      "session_lifecycle",
      "session_lifecycle",
      "session_lifecycle",
      "session_lifecycle",
    ]);
  });
});

// ----------------------------------------------------------------------------
// One method per event type: one row, its type and category, a schema-parsed payload, and a state
// the method determines
// ----------------------------------------------------------------------------

describe("WorkspaceEventEmitter — per-event emission", () => {
  it("emitRepoAttached appends one repo.attached row in state attached", async () => {
    await makeEmitter().emitRepoAttached({
      sessionId: SESSION_ID,
      repoMountId: REPO_MOUNT_ID,
      actor: USER_ID,
    });

    expectPersistedPayload(readSingleRow("repo.attached"), {
      sessionId: SESSION_ID,
      repoMountId: REPO_MOUNT_ID,
      state: "attached",
      actor: USER_ID,
    });
  });

  it("emitRepoDetached appends one repo.detached row in state detached", async () => {
    await makeEmitter().emitRepoDetached({
      sessionId: SESSION_ID,
      repoMountId: REPO_MOUNT_ID,
      actor: USER_ID,
    });

    expectPersistedPayload(readSingleRow("repo.detached"), {
      sessionId: SESSION_ID,
      repoMountId: REPO_MOUNT_ID,
      state: "detached",
      actor: USER_ID,
    });
  });

  it("emitWorkspacePreparing appends one workspace.preparing row in state provisioning", async () => {
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

  it("takes no state from the caller — the method determines it", async () => {
    // Compile time: `state` is not part of the input, so the literal below is an excess property.
    await makeEmitter().emitWorkspaceStale({
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
      // @ts-expect-error — callers cannot pair a type with a state does not
      // give it.
      state: "ready",
    });

    // Runtime: a state forced past the compiler is ignored, so a row cannot misstate its own
    // transition.
    expectPersistedPayload(readSingleRow("workspace.stale"), {
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
      state: "stale",
      actor: null,
    });
  });

  it("persists a whitespace-padded actor VERBATIM — the family schema normalizes nothing", async () => {
    // The one non-canonical fixture: it keeps `expectPersistedPayload`'s literal-versus-parsed pair
    // discriminating. The actor schema accepts padding today and trims nothing.
    await makeEmitter().emitRepoAttached({
      sessionId: SESSION_ID,
      repoMountId: REPO_MOUNT_ID,
      actor: "  alice  ",
    });

    expectPersistedPayload(readSingleRow("repo.attached"), {
      sessionId: SESSION_ID,
      repoMountId: REPO_MOUNT_ID,
      state: "attached",
      actor: "  alice  ",
    });
  });
});

// ----------------------------------------------------------------------------
// monotonic_ns and sequence
// ----------------------------------------------------------------------------

describe("WorkspaceEventEmitter — monotonic_ns and sequence", () => {
  it("persists the injected monotonic_ns", async () => {
    await makeEmitter({ monotonicNow: () => 7_000_000_000n }).emitRepoAttached({
      sessionId: SESSION_ID,
      repoMountId: REPO_MOUNT_ID,
    });

    const row: LifecycleRow = readSingleRow("repo.attached");
    expect(row.monotonic_ns).toBe(7_000_000_000n);
  });

  it("lets the append path allocate every sequence — successive emits advance it", async () => {
    const emitter: WorkspaceEventEmitter = makeEmitter();
    const attached: EventLogAppendReceipt = await emitter.emitRepoAttached({
      sessionId: SESSION_ID,
      repoMountId: REPO_MOUNT_ID,
    });
    const ready: EventLogAppendReceipt = await emitter.emitWorkspaceReady({
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
    });

    // The receipts carry the sequences the append path assigned, not ones the emitter invented.
    expect([attached.sequence, ready.sequence]).toEqual([0, 1]);
    expect(readRawRows(ctx.db, SESSION_ID).map((row) => row.sequence)).toEqual([0n, 1n]);
  });
});

// ----------------------------------------------------------------------------
// Envelope and payload agreement, and which subject id an event carries
// ----------------------------------------------------------------------------

describe("WorkspaceEventEmitter — envelope/payload reconciliation", () => {
  it("populates the envelope and the payload from ONE sessionId and actor input", async () => {
    await makeEmitter().emitRepoAttached({
      sessionId: SESSION_ID,
      repoMountId: REPO_MOUNT_ID,
      actor: USER_ID,
    });

    const row: LifecycleRow = readSingleRow("repo.attached");
    const persisted: Record<string, unknown> = JSON.parse(row.payload) as Record<string, unknown>;
    // One input feeds both, so the row and its payload cannot disagree.
    expect(row.actor).toBe(USER_ID);
    expect(persisted["actor"]).toBe(USER_ID);
    expect(persisted["sessionId"]).toBe(SESSION_ID);
  });

  it("keeps the envelope-only linkage fields out of the payload", async () => {
    const appended: UnsequencedEventEnvelope[] = [];
    const emitter: WorkspaceEventEmitter = new WorkspaceEventEmitter({
      sessionEvents: recordingEventLog(appended),
    });
    await emitter.emitWorkspaceArchived({
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
      correlationId: "corr-1",
      causationId: "cause-1",
    });

    const envelope: UnsequencedEventEnvelope | undefined = appended[0];
    expect(envelope?.correlationId).toBe("corr-1");
    expect(envelope?.causationId).toBe("cause-1");
    // Correlation and causation are envelope linkage and stay out of the payload.
    expect(envelope?.payload).toEqual({
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
      state: "archived",
      actor: null,
    });
  });

  it("omits the correlation pair entirely when the caller supplies none", async () => {
    // The envelope types the pair as optional, not nullable, so absent is the no-value form.
    const appended: UnsequencedEventEnvelope[] = [];
    const emitter: WorkspaceEventEmitter = new WorkspaceEventEmitter({
      sessionEvents: recordingEventLog(appended),
    });
    await emitter.emitRepoAttached({ sessionId: SESSION_ID, repoMountId: REPO_MOUNT_ID });

    const envelope: UnsequencedEventEnvelope | undefined = appended[0];
    expect(envelope).toBeDefined();
    expect(Object.hasOwn(envelope ?? {}, "correlationId")).toBe(false);
    expect(Object.hasOwn(envelope ?? {}, "causationId")).toBe(false);
  });

  it("names both ids on a detach-cascade workspace archival", async () => {
    // A workspace archived because its mount detached carries both ids, so a reader holding only
    // the mount can attribute the archival.
    await makeEmitter().emitWorkspaceArchived({
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
      repoMountId: REPO_MOUNT_ID,
      actor: USER_ID,
    });

    expectPersistedPayload(readSingleRow("workspace.archived"), {
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
      repoMountId: REPO_MOUNT_ID,
      state: "archived",
      actor: USER_ID,
    });
  });

  it("omits repoMountId from a workspace payload when the caller names no mount", async () => {
    // Which optional id an event carries identifies its subject, so the key must be absent, not
    // present with an undefined value.
    await makeEmitter().emitWorkspaceReady({
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
    });

    const row: LifecycleRow = readSingleRow("workspace.ready");
    const persisted: Record<string, unknown> = JSON.parse(row.payload) as Record<string, unknown>;
    expect(Object.hasOwn(persisted, "repoMountId")).toBe(false);
    expect(Object.hasOwn(persisted, "worktreeId")).toBe(false);
  });
});

// ----------------------------------------------------------------------------
// Emission boundary: the family schema is a gate before the append
// ----------------------------------------------------------------------------
//
// Each input is type-valid, so these exercise the runtime parse. Each test asserts the rejection
// and that nothing was persisted; a parse that ran after the append would fail the second check.

describe("WorkspaceEventEmitter — emission-boundary rejection", () => {
  it("rejects a non-UUID repoMountId and appends nothing", async () => {
    await expect(
      makeEmitter().emitRepoAttached({
        sessionId: SESSION_ID,
        repoMountId: "not-a-uuid",
      }),
    ).rejects.toThrow();
    expect(readRawRows(ctx.db, SESSION_ID)).toHaveLength(0);
  });

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

  it("rejects a whitespace-only actor and appends nothing", async () => {
    // A blank actor is a producer bug; a system actor is null or absent. Only all-whitespace is
    // blank: padding around content passes and persists verbatim.
    await expect(
      makeEmitter().emitRepoDetached({
        sessionId: SESSION_ID,
        repoMountId: REPO_MOUNT_ID,
        actor: "   ",
      }),
    ).rejects.toThrow();
    expect(readRawRows(ctx.db, SESSION_ID)).toHaveLength(0);
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

// ----------------------------------------------------------------------------
// Determinism: injected clock and id reach the persisted row
// ----------------------------------------------------------------------------

describe("WorkspaceEventEmitter — determinism (injected monotonicNow/now/newEventId)", () => {
  it("flows injected monotonicNow, now, and newEventId through to the persisted row", async () => {
    // The timestamp is canonical on purpose: the append path normalizes anything else, which would
    // hide whether the injected value flowed through.
    const FIXED_MONOTONIC: bigint = 4_242_000_000n;
    const FIXED_OCCURRED_AT: string = "2026-08-04T09:15:00.000Z";
    const FIXED_EVENT_ID: string = "evt-deterministic-0";

    const emitter: WorkspaceEventEmitter = new WorkspaceEventEmitter({
      sessionEvents: ctx.eventLog,
      monotonicNow: () => FIXED_MONOTONIC,
      now: () => FIXED_OCCURRED_AT,
      newEventId: () => FIXED_EVENT_ID,
    });

    const returned: EventLogAppendReceipt = await emitter.emitRepoAttached({
      sessionId: SESSION_ID,
      repoMountId: REPO_MOUNT_ID,
    });

    // Only this test fails for an emitter that ignores the injected sources and calls the
    // production ones directly.
    expect(returned.id).toBe(FIXED_EVENT_ID);

    const row: LifecycleRow = readSingleRow("repo.attached");
    expect(row.monotonic_ns).toBe(FIXED_MONOTONIC);
    expect(row.occurred_at).toBe(FIXED_OCCURRED_AT);
  });

  it("defaults newEventId to a unique-per-emit source so successive emits do not collide on the PRIMARY KEY", async () => {
    // With no override the default `mintUuidV7` must give each emit a distinct id; a constant would
    // collide on the primary key.
    const emitter: WorkspaceEventEmitter = new WorkspaceEventEmitter({
      sessionEvents: ctx.eventLog,
    });

    const first: EventLogAppendReceipt = await emitter.emitRepoAttached({
      sessionId: SESSION_ID,
      repoMountId: REPO_MOUNT_ID,
    });
    const second: EventLogAppendReceipt = await emitter.emitWorkspaceReady({
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
    });

    expect(first.id).not.toBe(second.id);
    expect(readRawRows(ctx.db, SESSION_ID)).toHaveLength(2);
  });
});

// ----------------------------------------------------------------------------
// WorkspaceEventLog seam: plain-object logs, plus one real-append test for the prelude abort
// ----------------------------------------------------------------------------

describe("WorkspaceEventEmitter — WorkspaceEventLog seam", () => {
  it("emits through a plain-object log implementation (no EventLogService, no database)", async () => {
    const appended: UnsequencedEventEnvelope[] = [];
    const emitter: WorkspaceEventEmitter = new WorkspaceEventEmitter({
      sessionEvents: recordingEventLog(appended),
      newEventId: makeCounterIdSource("structural"),
    });

    const attached: EventLogAppendReceipt = await emitter.emitRepoAttached({
      sessionId: SESSION_ID,
      repoMountId: REPO_MOUNT_ID,
    });
    const ready: EventLogAppendReceipt = await emitter.emitWorkspaceReady({
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
    });

    expect(appended).toHaveLength(2);
    expect(appended[0]?.type).toBe("repo.attached");
    expect(appended[1]?.type).toBe("workspace.ready");
    // The emitter returns the seam's sequences as given.
    expect([attached.sequence, ready.sequence]).toEqual([0, 1]);
  });

  it("forwards a caller-supplied transactionalPrelude to the append verbatim", async () => {
    // The prelude is how a producer writes atomically with the event. The emitter must forward the
    // same closure untouched, so identity is the assertion.
    const forwardedOptions: Array<{ transactionalPrelude?: () => void }> = [];
    const capturingEventLog: WorkspaceEventLog = {
      append: (envelope, options) => {
        forwardedOptions.push(options ?? {});
        return Promise.resolve({ id: envelope.id, sequence: 0 });
      },
    };
    const prelude = (): void => {};

    await new WorkspaceEventEmitter({ sessionEvents: capturingEventLog }).emitRepoAttached({
      sessionId: SESSION_ID,
      repoMountId: REPO_MOUNT_ID,
      transactionalPrelude: prelude,
    });

    expect(forwardedOptions).toHaveLength(1);
    expect(forwardedOptions[0]?.transactionalPrelude).toBe(prelude);
  });

  it("omits transactionalPrelude entirely when the caller supplies none", async () => {
    // The key must be absent, not present with an undefined value.
    const forwardedOptions: Array<Record<string, unknown>> = [];
    const capturingEventLog: WorkspaceEventLog = {
      append: (envelope, options) => {
        forwardedOptions.push((options ?? {}) as Record<string, unknown>);
        return Promise.resolve({ id: envelope.id, sequence: 0 });
      },
    };

    await new WorkspaceEventEmitter({ sessionEvents: capturingEventLog }).emitRepoAttached({
      sessionId: SESSION_ID,
      repoMountId: REPO_MOUNT_ID,
    });

    expect(forwardedOptions[0]).toBeDefined();
    expect(Object.hasOwn(forwardedOptions[0] ?? {}, "transactionalPrelude")).toBe(false);
  });

  it("aborts the append when the forwarded prelude throws against the real path — no row persists", async () => {
    // Against the real append path the prelude runs inside the transaction, so its throw aborts
    // before the INSERT and reaches the producer. An emitter that wrapped, deferred or ran the
    // prelude itself, or swallowed the rejection, passes the identity tests and fails here.
    await expect(
      makeEmitter().emitRepoAttached({
        sessionId: SESSION_ID,
        repoMountId: REPO_MOUNT_ID,
        transactionalPrelude: () => {
          throw new Error("prelude divergence");
        },
      }),
    ).rejects.toThrow("prelude divergence");
    expect(readRawRows(ctx.db, SESSION_ID)).toHaveLength(0);
  });

  it("rejects a synchronous append at COMPILE time (Promise return, not undefined)", async () => {
    // The compile-time layer of the contract: `undefined` is not assignable to
    // `Promise<EventLogAppendReceipt>`.
    const compileRejectedEventLog: WorkspaceEventLog = {
      // @ts-expect-error — a synchronous `append` (returns `undefined`) does
      // not satisfy `append(envelope, options): Promise<EventLogAppendReceipt>`.
      append: (): undefined => undefined,
    };
    // The object still exists at runtime, where the fail-closed guard catches it.
    await expect(
      new WorkspaceEventEmitter({ sessionEvents: compileRejectedEventLog }).emitRepoAttached({
        sessionId: SESSION_ID,
        repoMountId: REPO_MOUNT_ID,
      }),
    ).rejects.toThrow(/did not return a promise/);
  });

  it("refuses a non-thenable append fail-closed", async () => {
    // Only wiring the compiler never saw reaches the runtime guard, which the cast below models. A
    // synchronous append would report success before the write is durable.
    const appendCalls: UnsequencedEventEnvelope[] = [];
    const syncEventLog: WorkspaceEventLog = {
      append: (envelope): Promise<EventLogAppendReceipt> => {
        appendCalls.push(envelope);
        return undefined as unknown as Promise<EventLogAppendReceipt>;
      },
    };

    await expect(
      new WorkspaceEventEmitter({ sessionEvents: syncEventLog }).emitRepoAttached({
        sessionId: SESSION_ID,
        repoMountId: REPO_MOUNT_ID,
      }),
    ).rejects.toThrow(/did not return a promise[\s\S]*transactionalPrelude/);

    // The guard is loud, not preventive: the append has already run when the non-promise returns.
    expect(appendCalls).toHaveLength(1);
  });

  it("admits a custom thenable (duck-typed, not instanceof Promise)", async () => {
    // `await` accepts any object with a `then` function, so the guard must too. An `instanceof
    // Promise` check would wrongly reject a userland promise, and only this test would notice.
    const receipt: EventLogAppendReceipt = { id: "x", sequence: 3 };
    const customThenableEventLog: WorkspaceEventLog = {
      append: (): Promise<EventLogAppendReceipt> =>
        ({
          then: (resolve?: (value: EventLogAppendReceipt) => void) => resolve?.(receipt),
        }) as unknown as Promise<EventLogAppendReceipt>,
    };

    await expect(
      new WorkspaceEventEmitter({ sessionEvents: customThenableEventLog }).emitRepoAttached({
        sessionId: SESSION_ID,
        repoMountId: REPO_MOUNT_ID,
      }),
    ).resolves.toEqual(receipt);
  });

  it("propagates a REJECTING append unchanged", async () => {
    // A rejection is how a producer learns its write did not commit; it must reach the caller
    // instead of being reported as success.
    const rejectingEventLog: WorkspaceEventLog = {
      append: (): Promise<EventLogAppendReceipt> => Promise.reject(new Error("append lock lost")),
    };

    await expect(
      new WorkspaceEventEmitter({ sessionEvents: rejectingEventLog }).emitRepoAttached({
        sessionId: SESSION_ID,
        repoMountId: REPO_MOUNT_ID,
      }),
    ).rejects.toThrow("append lock lost");
  });
});
