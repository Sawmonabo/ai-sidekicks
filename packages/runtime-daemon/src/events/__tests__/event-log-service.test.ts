// `EventLogService`, the sole durable append path: per-session sequencing under the append lock,
// the head read boundary, the stored-variant parse and the terminal-run backstop, each asserted
// on the stored rows.

import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CONTENT_LENGTH_PAYLOAD_KEY,
  CONTENT_TRUNCATED_PAYLOAD_KEY,
} from "@ai-sidekicks/contracts/event/declared-variants";
import { EventEnvelopeVersionSchema } from "@ai-sidekicks/contracts/event/envelope";
import { SessionIdSchema, type SessionId } from "@ai-sidekicks/contracts/session/session";

import { drainMicrotasks } from "../../provider/__fixtures__/drain-microtasks.js";
import { openDatabase } from "../../session/migration-runner.js";
import { EventLogService, type UnsequencedEventEnvelope } from "../event-log-service.js";
import { withSessionAppendLock } from "../session/append-lock.js";
import { writeAcrossStrictTyping } from "../../session/__fixtures__/at-rest-tamper.js";

const SESSION: SessionId = SessionIdSchema.parse("0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f10");
const OTHER_SESSION: SessionId = SessionIdSchema.parse("0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f11");
const ENVELOPE_VERSION = EventEnvelopeVersionSchema.parse("1.0");

let database: DatabaseType;

beforeEach(() => {
  // The production migration runner, not hand-rolled DDL: the terminal-key triggers and the
  // `UNIQUE(session_id, sequence)` key are part of what these tests assert.
  database = openDatabase(":memory:");
});

afterEach(() => {
  database.close();
});

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

/**
 * Whether `work` settles within `turns` macrotasks.
 *
 * A leaked hold shows as a promise that never settles, which a plain `await` turns into a
 * suite-wide timeout; sampling a bounded number of turns fails the named test instead.
 */
async function settlesWithin(work: Promise<unknown>, turns: number): Promise<boolean> {
  let settled = false;
  const observe = (): void => {
    settled = true;
  };
  void work.then(observe, observe);
  for (let turn = 0; turn < turns; turn += 1) await drainMicrotasks();
  return settled;
}

interface ServiceFixture {
  readonly service: EventLogService;
}

function buildService(): ServiceFixture {
  return { service: new EventLogService({ db: database }) };
}

let envelopeCounter = 0;

function makeEnvelope(overrides?: Partial<UnsequencedEventEnvelope>): UnsequencedEventEnvelope {
  envelopeCounter += 1;
  return {
    id: `evt-${String(envelopeCounter).padStart(4, "0")}`,
    sessionId: SESSION,
    occurredAt: "2026-08-04T12:00:00.000Z",
    category: "session_lifecycle",
    type: "session.updated",
    actor: null,
    payload: { note: `append ${String(envelopeCounter)}` },
    version: ENVELOPE_VERSION,
    ...overrides,
  };
}

interface RawEventRow {
  readonly id: string;
  readonly session_id: string;
  readonly sequence: number;
  readonly occurred_at: string;
  readonly category: string;
  readonly type: string;
  readonly actor: string | null;
  readonly payload: string;
  readonly correlation_id: string | null;
  readonly causation_id: string | null;
  readonly version: string;
}

function readRawRows(sessionId: SessionId): ReadonlyArray<RawEventRow> {
  return database
    .prepare("SELECT * FROM session_events WHERE session_id = ? ORDER BY sequence ASC")
    .all(sessionId) as ReadonlyArray<RawEventRow>;
}

// ----------------------------------------------------------------------------
// Sequence allocation
// ----------------------------------------------------------------------------

describe("EventLogService — sequence allocation", () => {
  it("allocates per session — each session opens at its own sequence 0", async () => {
    const { service } = buildService();

    await service.append(makeEnvelope());
    await service.append(makeEnvelope({ sessionId: OTHER_SESSION }));
    await service.append(makeEnvelope());
    await service.append(makeEnvelope({ sessionId: OTHER_SESSION }));

    expect(readRawRows(SESSION).map((row) => row.sequence)).toEqual([0, 1]);
    expect(readRawRows(OTHER_SESSION).map((row) => row.sequence)).toEqual([0, 1]);
  });
});

// ----------------------------------------------------------------------------
// The head read boundary — `sequence` read as `unknown`, then narrowed
// ----------------------------------------------------------------------------

describe("EventLogService — head read boundary", () => {
  it("refuses a head whose sequence is not an INTEGER rather than allocating from it", async () => {
    // SQLite orders TEXT above every INTEGER, so a TEXT `sequence` becomes the head that
    // `ORDER BY sequence DESC` selects. Two rows, the lower one corrupted: with one row the corrupt
    // value is the head whatever the query orders by, so a lost `ORDER BY` would go unnoticed.
    const { service } = buildService();
    await service.append(makeEnvelope());
    await service.append(makeEnvelope());

    writeAcrossStrictTyping(database, "session_events", () => {
      database
        .prepare("UPDATE session_events SET sequence = 'x' WHERE session_id = ? AND sequence = 0")
        .run(SESSION);
    });

    await expect(service.append(makeEnvelope())).rejects.toThrow(
      /session_events\.sequence for session .+ is not an INTEGER: got a value of type string/,
    );
    // Unnarrowed, `Number('x') + 1` is `NaN`, which would be stored as the next sequence.
    expect(readRawRows(SESSION)).toHaveLength(2);
  });
});

// ----------------------------------------------------------------------------
// The plain branch parses what it stores (`assertRegisteredVariantParses`)
// ----------------------------------------------------------------------------

describe("EventLogService — the plain branch parses what it stores", () => {
  /** A `session.created` payload its own registered variant accepts. */
  const validSessionCreatedPayload = {
    sessionId: SESSION,
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
      createdAt: "2026-08-01T00:00:00.000Z",
    },
  };

  it("refuses a REGISTERED type whose payload its variant rejects, before writing", async () => {
    // A refusal after the INSERT would leave the row behind; one after sequencing would push the
    // next append to 1.
    const { service } = buildService();
    const rejected = makeEnvelope({
      type: "session.created",
      payload: { note: "not the registered shape" },
    });

    await expect(service.append(rejected)).rejects.toThrow(
      /EventLogService\.append refuses to store an event of type "session\.created"/,
    );
    // The refusal names the offending members, so the caller can fix the payload.
    await expect(service.append(rejected)).rejects.toThrow(/payload\.sessionId \(invalid_type\)/);

    expect(readRawRows(SESSION)).toHaveLength(0);
    const readmitted = await service.append(
      makeEnvelope({ type: "session.created", payload: validSessionCreatedPayload }),
    );
    expect(readmitted.sequence).toBe(0);
  });
});

// ----------------------------------------------------------------------------
// The content description members on the plain path
// ----------------------------------------------------------------------------
//
// The plain-vs-content branch is chosen from `options.content`, not from the payload. A caller that
// omits `options.content` and seeds `contentLength` would take the plain branch and store a row
// whose account of its own body describes prose the column does not hold. The reader echoes those
// members instead of recomputing them, so the refusal has to happen at the write.

describe("EventLogService — content description members are refused on the plain path", () => {
  const forgeableMembers: ReadonlyArray<readonly [string, unknown]> = [
    [CONTENT_LENGTH_PAYLOAD_KEY, 4096],
    [CONTENT_TRUNCATED_PAYLOAD_KEY, true],
  ];

  it.each(forgeableMembers)("refuses a payload pre-seeding %s", async (key, value) => {
    // Both members are the row's own account of how much prose there was and whether the bound
    // fired; the body read echoes them from the stored payload, so a lie would be read
    // back as truth.
    const { service } = buildService();

    await expect(
      service.append(
        makeEnvelope({
          type: "assistant.message",
          category: "assistant_output",
          payload: {
            sessionId: SESSION,
            runId: "run-1",
            contentType: "text/markdown",
            [key]: value,
          },
        }),
      ),
    ).rejects.toThrow(
      new RegExp(`EventLogService\\.append refuses an event whose payload already carries ${key}`),
    );
  });
});

// ----------------------------------------------------------------------------
// Serialization — the per-session append lock
// ----------------------------------------------------------------------------

describe("EventLogService — the append lock", () => {
  it("serializes concurrent appends on one session into one gapless sequence", async () => {
    const { service } = buildService();

    // Without the lock these interleave in the async compose step and two derive the same
    // `sequence`, one losing to `UNIQUE(session_id, sequence)`.
    await Promise.all(
      Array.from({ length: 16 }, (_unused, index) =>
        service.append(makeEnvelope({ payload: { index } })),
      ),
    );

    const rows = readRawRows(SESSION);
    expect(rows).toHaveLength(16);
    expect(rows.map((row) => row.sequence)).toEqual(
      Array.from({ length: 16 }, (_unused, index) => index),
    );
  });

  it("reuses an existing hold rather than deadlocking on it (owner-scoped reentry)", async () => {
    // Producers read and decide under the lock, then append inside the same hold; a non-reentrant
    // mutex would deadlock here.
    const { service } = buildService();

    const receipt = await withSessionAppendLock(SESSION, async () => {
      return service.append(makeEnvelope());
    });

    expect(receipt.sequence).toBe(0);
  });

  it("does not let one session's hold block another session's append", async () => {
    const { service } = buildService();
    let release!: () => void;
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = withSessionAppendLock(SESSION, async () => {
      await parked;
    });
    await drainMicrotasks();

    // The lock is keyed on `sessionId`; a global mutex would make this pend.
    await expect(service.append(makeEnvelope({ sessionId: OTHER_SESSION }))).resolves.toMatchObject(
      { sequence: 0 },
    );

    release();
    await holding;
  });

  it("makes two parallel holds on one session take turns", async () => {
    // Tests the lock directly rather than through `append()`, so "the second one waits" holds for
    // any critical section.
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstParked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withSessionAppendLock(SESSION, async () => {
      order.push("first-enter");
      await firstParked;
      order.push("first-exit");
    });
    const second = withSessionAppendLock(SESSION, () => {
      order.push("second-enter");
      return Promise.resolve();
    });

    expect(await settlesWithin(second, 4)).toBe(false);
    expect(order).toEqual(["first-enter"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-enter", "first-exit", "second-enter"]);
  });

  it("releases the hold to a WAITER when the acquiring critical section rejects", async () => {
    // The lock state is a module singleton, so a hold leaked on rejection wedges the session until
    // the process restarts. The waiter queues before the failure on purpose: a caller arriving
    // after the rejection finds the queue entry already drained and proceeds even from a leaked
    // hold. Moving the release out of its `finally` survives that form but not this one.
    const { service } = buildService();
    let failCriticalSection!: (reason: Error) => void;
    const criticalOutcome = new Promise<void>((_resolve, reject) => {
      failCriticalSection = reject;
    });

    const rejecting = withSessionAppendLock(SESSION, () => criticalOutcome);
    const queuedBehind = service.append(makeEnvelope());
    expect(await settlesWithin(queuedBehind, 2)).toBe(false);

    failCriticalSection(new Error("producer aborted"));
    await expect(rejecting).rejects.toThrow(/producer aborted/);

    expect(await settlesWithin(queuedBehind, 4)).toBe(true);
    await expect(queuedBehind).resolves.toMatchObject({ sequence: 0 });
  });

  it("releases nothing when a REENTRANT frame rejects and its owner catches it", async () => {
    // An owner that catches an inner rejection is still the owner. If the inner rejection released,
    // the outer frame would hold a lock it no longer owns, its next nested call would queue behind
    // itself, and the release would fire twice.
    const { service } = buildService();
    let innerRejectionCaught = false;
    let nestedCallProgressed = false;

    const receipt = await withSessionAppendLock(SESSION, async () => {
      try {
        await withSessionAppendLock(SESSION, () => Promise.reject(new Error("inner leg failed")));
      } catch {
        innerRejectionCaught = true;
      }
      const nested = service.append(makeEnvelope());
      nestedCallProgressed = await settlesWithin(nested, 4);
      // Abandon the nested call when it got no hold: awaiting it would hang the owner too and turn
      // a named failure into a suite-wide timeout.
      return nestedCallProgressed ? await nested : undefined;
    });

    expect(innerRejectionCaught).toBe(true);
    expect(nestedCallProgressed).toBe(true);
    expect(receipt?.sequence).toBe(0);

    // Released exactly once, on the owner's settle: a fresh acquisition now proceeds.
    const afterOwnerSettled = withSessionAppendLock(SESSION, () => Promise.resolve("free"));
    expect(await settlesWithin(afterOwnerSettled, 4)).toBe(true);
  });

  it("rolls the transaction back when the prelude throws, consuming no sequence", async () => {
    const { service } = buildService();
    database.exec("CREATE TABLE prelude_probe (id TEXT PRIMARY KEY, seen_events INTEGER NOT NULL)");
    await service.append(makeEnvelope());

    await expect(
      service.append(makeEnvelope(), {
        transactionalPrelude: () => {
          database.prepare("INSERT INTO prelude_probe VALUES (?, ?)").run("doomed", 1);
          throw new Error("producer detected divergent decision-time state");
        },
      }),
    ).rejects.toThrow(/divergent/);

    // Neither half landed, and the next append re-derives its sequence from the durable head row.
    expect(database.prepare("SELECT COUNT(*) AS c FROM prelude_probe").get()).toEqual({ c: 0 });
    expect(readRawRows(SESSION)).toHaveLength(1);
    await expect(service.append(makeEnvelope())).resolves.toMatchObject({ sequence: 1 });
  });
});

// ----------------------------------------------------------------------------
// The run_lifecycle terminal-key backstop, seen from `append()`
// ----------------------------------------------------------------------------

// Every terminal run_lifecycle type; the schema's partial index and triggers list the same four.
const TERMINAL_RUN_TYPES = [
  "run.completed",
  "run.failed",
  "run.interrupted",
  "run.stopped",
] as const satisfies ReadonlyArray<UnsequencedEventEnvelope["type"]>;

function terminalEnvelope(
  payload: Record<string, unknown>,
  type: (typeof TERMINAL_RUN_TYPES)[number] = "run.completed",
): UnsequencedEventEnvelope {
  return makeEnvelope({ category: "run_lifecycle", type, payload });
}

describe("EventLogService — terminal-key backstop", () => {
  it.each(TERMINAL_RUN_TYPES)(
    "admits the first %s for a run and refuses a second terminal of each type",
    async (firstType) => {
      const { service } = buildService();

      await service.append(terminalEnvelope({ runId: "run-1", runVersion: 1 }, firstType));

      for (const secondType of TERMINAL_RUN_TYPES) {
        await expect(
          service.append(terminalEnvelope({ runId: "run-1", runVersion: 1 }, secondType)),
          `${secondType} after ${firstType} must be refused`,
        ).rejects.toThrow(/UNIQUE/i);
      }

      // The refusal costs no sequence: the INSERT aborts inside the transaction.
      expect(readRawRows(SESSION)).toHaveLength(1);
      await expect(service.append(makeEnvelope())).resolves.toMatchObject({ sequence: 1 });
    },
  );

  it("admits a terminal for another run, or the same run at a new runVersion", async () => {
    // The key is the (runId, runVersion) pair: another run, or a re-run at a new `runVersion`, has
    // its own terminal event.
    const { service } = buildService();

    await service.append(terminalEnvelope({ runId: "run-1", runVersion: 1 }));
    await expect(
      service.append(terminalEnvelope({ runId: "run-2", runVersion: 1 })),
    ).resolves.toMatchObject({ sequence: 1 });
    await expect(
      service.append(terminalEnvelope({ runId: "run-1", runVersion: 2 })),
    ).resolves.toMatchObject({ sequence: 2 });
  });

  it("lets a NON-terminal run_lifecycle duplicate through (index is terminal-only)", async () => {
    // `run_lifecycle` also carries non-terminal types; an index guarding the whole category would
    // refuse the ordinary progression events.
    const { service } = buildService();
    const runKey = { runId: "run-1", runVersion: 1 };

    await service.append(
      makeEnvelope({ category: "run_lifecycle", type: "run.running", payload: runKey }),
    );
    await expect(
      service.append(
        makeEnvelope({ category: "run_lifecycle", type: "run.running", payload: runKey }),
      ),
    ).resolves.toMatchObject({ sequence: 1 });
  });

  it("refuses a terminal event whose run key is missing or the wrong storage class", async () => {
    // SQLite treats NULLs as distinct in a UNIQUE index, so a terminal row with no `$.runId`
    // conflicts with nothing, and `json_extract` returns SQLite values, so a stringified
    // `runVersion` is a different key from the integer. The trigger closes both.
    const { service } = buildService();
    const refusedPayloads: ReadonlyArray<Record<string, unknown>> = [
      { runVersion: 1 },
      { runId: "run-1" },
      { runId: 7, runVersion: 1 },
      { runId: "run-1", runVersion: "1" },
      { runId: "run-1", runVersion: 1.5 },
      { runId: null, runVersion: 1 },
    ];

    for (const payload of refusedPayloads) {
      await expect(
        service.append(terminalEnvelope(payload)),
        `payload ${JSON.stringify(payload)} must be refused`,
      ).rejects.toThrow(/terminal run_lifecycle requires/);
    }

    expect(readRawRows(SESSION)).toHaveLength(0);
  });

  it("refuses an UPDATE promoting a committed non-terminal row into a terminal one", async () => {
    // The INSERT trigger cannot see this: a row outside the partial index's predicate is UPDATEd
    // into it. Terminal rows are INSERT-only.
    const { service } = buildService();
    const receipt = await service.append(
      makeEnvelope({
        category: "run_lifecycle",
        type: "run.running",
        payload: { runId: "run-1", runVersion: 1 },
      }),
    );

    expect(() =>
      database
        .prepare("UPDATE session_events SET category = ?, type = ? WHERE id = ?")
        .run("run_lifecycle", "run.completed", receipt.id),
    ).toThrow(/cannot be promoted to terminal/);
  });

  it("refuses an UPDATE that moves or drops a committed terminal row's run key", async () => {
    const { service } = buildService();
    const receipt = await service.append(terminalEnvelope({ runId: "run-1", runVersion: 1 }));

    // The index constrains which keys are live, not their stability: rewriting a key moves it, so
    // the index stays satisfied while the record attributes the terminal event to another run.
    // Both halves of the pair are pinned because the guard compares them independently.
    expect(() =>
      database
        .prepare("UPDATE session_events SET payload = ? WHERE id = ?")
        .run(JSON.stringify({ runId: "run-2", runVersion: 1 }), receipt.id),
    ).toThrow(/must preserve runId/);
    expect(() =>
      database
        .prepare("UPDATE session_events SET payload = ? WHERE id = ?")
        .run(JSON.stringify({ runId: "run-1", runVersion: 2 }), receipt.id),
    ).toThrow(/must preserve runId/);

    // Moving a row out of the partial index's predicate frees its key for reuse. `category` and
    // `type` are independent disjuncts in the guard, so each needs its own case.
    expect(() =>
      database
        .prepare("UPDATE session_events SET category = ? WHERE id = ?")
        .run("session_lifecycle", receipt.id),
    ).toThrow(/must preserve runId/);
    expect(() =>
      database
        .prepare("UPDATE session_events SET type = ? WHERE id = ?")
        .run("run.running", receipt.id),
    ).toThrow(/must preserve runId/);

    // Dropping the key makes both `json_extract` values NULL, which the value-equality check
    // cannot see and the NULL-distinct index allows, so a rewrite that forgets the run key would
    // silently reopen the duplicate-terminal bypass.
    for (const droppedPayload of [{ runVersion: 1 }, { runId: "run-1" }, { note: "rewritten" }]) {
      expect(
        () =>
          database
            .prepare("UPDATE session_events SET payload = ? WHERE id = ?")
            .run(JSON.stringify(droppedPayload), receipt.id),
        `payload ${JSON.stringify(droppedPayload)} must be refused`,
      ).toThrow(/must preserve runId/);
    }

    // The row is untouched, so the backstop still holds against a real duplicate.
    await expect(
      service.append(terminalEnvelope({ runId: "run-1", runVersion: 1 })),
    ).rejects.toThrow(/UNIQUE/i);
  });
});
