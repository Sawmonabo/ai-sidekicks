// SessionService over SQLite: replay order, restart durability, the append guard and the
// read-side payload check. Each test gets its own database file under os.tmpdir().

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase } from "../migration-runner.js";
import { SessionService, TestSeedingAppendToken } from "../session-service.js";
import type { AppendableEvent } from "../types.js";

// ----------------------------------------------------------------------------
// Test fixtures
// ----------------------------------------------------------------------------

const SESSION_ID: string = "01J0SE5510NN5J5J5J5J5J5J5J";
const OWNER_ID: string = "01J0PA0000NN5J5J5J5J5J5J5J";

function makeCreatedEvent(): AppendableEvent {
  return {
    id: "01J0EV0000NN5J5J5J5J5J5J5J",
    sessionId: SESSION_ID,
    sequence: 0,
    occurredAt: "2026-04-27T12:00:00.000Z",
    monotonicNs: 1_000_000_000n,
    category: "session_lifecycle",
    type: "session.created",
    actor: OWNER_ID,
    payload: {
      sessionId: SESSION_ID,
      shape: "chat",
      mainAgent: {
        agentId: "44444444-4444-4444-8444-444444444444",
        name: "Implementer",
        binding: {
          driverName: "claude",
          modelId: "claude-sonnet-5",
          providerAccountId: null,
          effort: null,
        },
        ancestry: [],
        createdAt: "2026-04-27T12:00:00.000Z",
      },
    },
    correlationId: null,
    causationId: null,
    version: "1.0",
  };
}

function makeRenamedEvent(sequence: number, monotonicNs: bigint, name: string): AppendableEvent {
  return {
    id: `01J0EV0002NN5J5J5J5J5J5J0${sequence.toString()}`,
    sessionId: SESSION_ID,
    sequence,
    occurredAt: "2026-04-27T12:02:00.000Z",
    monotonicNs,
    category: "session_lifecycle",
    type: "session.renamed",
    actor: OWNER_ID,
    payload: { sessionId: SESSION_ID, name },
    correlationId: null,
    causationId: null,
    version: "1.0",
  };
}

// ----------------------------------------------------------------------------
// Per-test database lifecycle
// ----------------------------------------------------------------------------

interface TestContext {
  db: DatabaseType;
  service: SessionService;
  dbPath: string;
  tmpDir: string;
}

let ctx: TestContext;

beforeEach(() => {
  const tmpDir: string = mkdtempSync(join(tmpdir(), "ai-sidekicks-daemon-test-"));
  const dbPath: string = join(tmpDir, "test.db");
  // The production factory, so the test opens the database exactly as the daemon does.
  const db: DatabaseType = openDatabase(dbPath);
  ctx = {
    db,
    // Test-only opt-in to the guarded append path; the append-guard block pins the refusal on a
    // default-constructed service.
    service: new SessionService(db, {
      allowTestSeedingAppend: TestSeedingAppendToken.forTestsOnly(),
    }),
    dbPath,
    tmpDir,
  };
});

afterEach(() => {
  if (ctx.db.open) {
    ctx.db.close();
  }
  rmSync(ctx.tmpDir, { recursive: true, force: true });
});

// ----------------------------------------------------------------------------
// Sequence, not monotonic_ns
// ----------------------------------------------------------------------------

describe("SessionService — replay uses sequence not monotonic_ns", () => {
  it("orders events by sequence even when monotonic_ns goes backwards across rows", () => {
    // monotonic_ns is in-daemon debug data; sequence is the replay key, so clock skew in
    // monotonic_ns must not reorder replay.
    const e0: AppendableEvent = { ...makeCreatedEvent(), monotonicNs: 5_000_000_000n };
    const e1: AppendableEvent = makeRenamedEvent(1, 1_000_000_000n, "Back Room");
    const e2: AppendableEvent = makeRenamedEvent(2, 3_000_000_000n, "Side Room");

    ctx.service.append(e0);
    ctx.service.append(e1);
    ctx.service.append(e2);

    const events = ctx.service.readEvents(SESSION_ID);
    expect(events.map((e) => e.sequence)).toEqual([0, 1, 2]);
    expect(events.map((e) => e.monotonicNs)).toEqual([
      5_000_000_000n,
      1_000_000_000n,
      3_000_000_000n,
    ]);
    // Sorting by monotonic_ns would give [1, 2, 0], so the read path is not using it.
    const monotonicSorted = [...events].sort((a, b) => Number(a.monotonicNs - b.monotonicNs));
    expect(monotonicSorted.map((e) => e.sequence)).toEqual([1, 2, 0]);

    // Sequence order puts `session.created` first, so the snapshot still bootstraps.
    const snapshot = ctx.service.replay(SESSION_ID);
    expect(snapshot).not.toBeNull();
    if (snapshot === null) return;
    expect(snapshot.sessionId).toBe(SESSION_ID);
    expect(snapshot.asOfSequence).toBe(2);
  });

  it("round-trips a monotonic_ns value above Number.MAX_SAFE_INTEGER as bigint without precision loss", () => {
    // The other fixtures sit below Number.MAX_SAFE_INTEGER, so a `Number(row.monotonic_ns)`
    // regression in `hydrateRow` would not show. 2^53 + 1 is the first value a double cannot hold.
    const BIGINT_BOUNDARY: bigint = 9_007_199_254_740_993n; // 2^53 + 1
    const created: AppendableEvent = {
      ...makeCreatedEvent(),
      monotonicNs: BIGINT_BOUNDARY,
    };
    ctx.service.append(created);

    const events = ctx.service.readEvents(SESSION_ID);
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event).toBeDefined();
    if (event === undefined) return; // type guard for TS

    expect(typeof event.monotonicNs).toBe("bigint");
    // A `Number()` regression would come back as 2^53, one below the boundary.
    expect(event.monotonicNs).toBe(BIGINT_BOUNDARY);
    expect(event.monotonicNs).not.toBe(BIGINT_BOUNDARY - 1n);
  });
});

// ----------------------------------------------------------------------------
// Durability across daemon restart
// ----------------------------------------------------------------------------

describe("SessionService — snapshot survives daemon restart", () => {
  it("yields identical projection after closing and reopening the database file", () => {
    const created: AppendableEvent = makeCreatedEvent();
    const firstRename: AppendableEvent = makeRenamedEvent(1, 2_000_000_000n, "Design Review");
    const secondRename: AppendableEvent = makeRenamedEvent(2, 3_000_000_000n, "Release Notes");

    ctx.service.append(created);
    ctx.service.append(firstRename);
    ctx.service.append(secondRename);

    const beforeRestart = ctx.service.replay(SESSION_ID);
    expect(beforeRestart).not.toBeNull();

    // Closing the handle stands in for the daemon process exiting.
    ctx.db.close();
    expect(ctx.db.open).toBe(false);

    // Reopening the same file proves on-disk durability backs the projection. The reopened
    // service has no append opt-in on purpose: it only replays, which reads allow.
    const reopenedDb: DatabaseType = openDatabase(ctx.dbPath);
    const reopenedService: SessionService = new SessionService(reopenedDb);

    // afterEach closes whichever handle `ctx` holds.
    ctx.db = reopenedDb;
    ctx.service = reopenedService;

    const afterRestart = reopenedService.replay(SESSION_ID);
    expect(afterRestart).not.toBeNull();

    expect(afterRestart).toEqual(beforeRestart);

    if (afterRestart === null) return;
    expect(afterRestart.ownerActor).toBe(OWNER_ID);
    expect(afterRestart.asOfSequence).toBe(2);
  });
});

// ----------------------------------------------------------------------------
// Append guard
// ----------------------------------------------------------------------------
//
// A default-constructed service is read-only, so a composition root wiring a real database cannot
// reach the test-seeding append path, which bypasses the append lock, by accident.

describe("SessionService — append guard (test-seeding writes are opt-in)", () => {
  it("refuses append on a default-constructed service, naming the replacement writer and the opt-in", () => {
    const guardedService: SessionService = new SessionService(ctx.db);
    expect(() => guardedService.append(makeCreatedEvent())).toThrow(
      /SessionService\.append is guarded/,
    );
    // The message names where durable writes belong and how tests opt in.
    expect(() => guardedService.append(makeCreatedEvent())).toThrow(/EventLogService\.append/);
    expect(() => guardedService.append(makeCreatedEvent())).toThrow(
      /allowTestSeedingAppend.*TestSeedingAppendToken\.forTestsOnly\(\)/s,
    );
    // The refusal comes before any INSERT.
    expect(guardedService.readEvents(SESSION_ID)).toHaveLength(0);
  });

  it("refuses a forged token: the guard checks identity against the module-private singleton, not structure", () => {
    // A boolean opt-in could be threaded in from configuration. Deserialized or hand-built data
    // can never be the token singleton, so even a cast structural lookalike still throws.
    const forgedToken = Object.freeze({
      brand: "test-seeding-append",
    }) as unknown as TestSeedingAppendToken;
    const forgedService: SessionService = new SessionService(ctx.db, {
      allowTestSeedingAppend: forgedToken,
    });
    expect(() => forgedService.append(makeCreatedEvent())).toThrow(
      /SessionService\.append is guarded/,
    );
    expect(forgedService.readEvents(SESSION_ID)).toHaveLength(0);
  });
});

// ----------------------------------------------------------------------------
// Read-side payload trust boundary (parsePayload)
// ----------------------------------------------------------------------------
//
// `readEvents` parses each row's `payload` as JSON and requires a plain object, matching the wire
// schema's object payloads. A writer that bypasses `append()` and stores malformed JSON or a
// non-object value would otherwise surface as a misleading `TypeError` in the projector.
//
// The tests write through a raw statement: the `payload` column is `TEXT NOT NULL`, so SQLite
// accepts any string and the check must happen at hydration.

describe("SessionService — read-side payload validation", () => {
  function appendRaw(payloadText: string, sequence: number, id: string): void {
    ctx.db
      .prepare(
        `INSERT INTO session_events (
           id, session_id, sequence, occurred_at, monotonic_ns,
           category, type, payload
         ) VALUES (
           @id, @session_id, @sequence, @occurred_at, @monotonic_ns,
           @category, @type, @payload
         )`,
      )
      .run({
        id,
        session_id: SESSION_ID,
        sequence,
        occurred_at: "2026-04-27T12:00:00.000Z",
        monotonic_ns: 1n,
        category: "session_lifecycle",
        type: "session.created",
        payload: payloadText,
      });
  }

  it.each([
    ["null", "01J0EV8881NN5J5J5J5J5J5J5J", /payload must be a JSON object .* \(got null\)/],
    ['["a","b"]', "01J0EV8882NN5J5J5J5J5J5J5J", /payload must be a JSON object .* \(got array\)/],
    [
      '"plain string"',
      "01J0EV8883NN5J5J5J5J5J5J5J",
      /payload must be a JSON object .* \(got string\)/,
    ],
    ["{not valid json", "01J0EV8884NN5J5J5J5J5J5J5J", /payload is not valid JSON/],
  ])("throws a structured error for the stored payload %s", (payloadText, id, refusal) => {
    appendRaw(payloadText, 0, id);
    expect(() => ctx.service.readEvents(SESSION_ID)).toThrow(refusal);
  });
});
