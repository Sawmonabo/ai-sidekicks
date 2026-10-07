// `EventLogService`, the sole durable append path: per-session sequencing under the append lock,
// the head read boundary, the stored-variant parse and the terminal-run backstop, each asserted
// on the stored rows.

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CONTENT_LENGTH_PAYLOAD_KEY,
  CONTENT_TRUNCATED_PAYLOAD_KEY,
} from "@ai-sidekicks/contracts/event/declared-variants";
import { EventEnvelopeVersionSchema } from "@ai-sidekicks/contracts/event/envelope";
import { RunIdSchema, type RunId } from "@ai-sidekicks/contracts/run/id";
import { SessionIdSchema, type SessionId } from "@ai-sidekicks/contracts/session/id";

import { openScratchDatabase, type ScratchDatabase } from "../../database/__fixtures__/scratch.js";
import { drainMicrotasks } from "../../provider/__fixtures__/drain-microtasks.js";
import { EventLogService, type UnsequencedEventEnvelope } from "../log-service.js";
import { sessionAppendLock } from "../session/append-lock.js";
import { writeAcrossStrictTyping } from "../../session/__fixtures__/at-rest-tamper.js";
import { insertStoredEvent } from "../../session/__fixtures__/stored-event.js";

const SESSION: SessionId = SessionIdSchema.parse("0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f10");
const OTHER_SESSION: SessionId = SessionIdSchema.parse("0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f11");
const ENVELOPE_VERSION = EventEnvelopeVersionSchema.parse("1.0");

let scratch: ScratchDatabase;
// A second read-write connection, for the edits a file can carry that no daemon write makes.
let tamper: DatabaseType;

beforeEach(async () => {
  // The production schema, not hand-rolled DDL: the terminal-key triggers and the
  // `UNIQUE(session_id, sequence)` key are part of what these tests assert.
  scratch = await openScratchDatabase();
  tamper = new Database(scratch.databasePath);
});

afterEach(async () => {
  tamper.close();
  await scratch.close();
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
  return { service: new EventLogService({ writer: scratch.writer }) };
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
  return scratch.reader
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

    writeAcrossStrictTyping(tamper, "session_events", () => {
      tamper
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
    await expect(
      service.append(
        makeEnvelope({ type: "session.created", payload: validSessionCreatedPayload }),
      ),
    ).resolves.toMatchObject({ sequence: 0 });
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

    // Offered at once, the appends share batches; each still takes the next sequence, where two
    // deriving the same one would lose to `UNIQUE(session_id, sequence)`.
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
    // A producer holding the session appends inside the same hold; a non-reentrant mutex would
    // deadlock here.
    const { service } = buildService();

    const receipt = await sessionAppendLock.run(SESSION, async () => {
      return service.append(makeEnvelope());
    });

    expect(receipt).toMatchObject({ sequence: 0 });
  });

  it("does not let one session's hold block another session's append", async () => {
    const { service } = buildService();
    let release!: () => void;
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = sessionAppendLock.run(SESSION, async () => {
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

    const first = sessionAppendLock.run(SESSION, async () => {
      order.push("first-enter");
      await firstParked;
      order.push("first-exit");
    });
    const second = sessionAppendLock.run(SESSION, () => {
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

    const rejecting = sessionAppendLock.run(SESSION, () => criticalOutcome);
    const queuedBehind = service.append(makeEnvelope());
    expect(await settlesWithin(queuedBehind, 2)).toBe(false);

    failCriticalSection(new Error("producer aborted"));
    await expect(rejecting).rejects.toThrow(/producer aborted/);

    // Once past the lock the append is with the writer, and the flush commits it.
    await drainMicrotasks();
    await scratch.writer.flush();
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

    const receipt = await sessionAppendLock.run(SESSION, async () => {
      try {
        await sessionAppendLock.run(SESSION, () => Promise.reject(new Error("inner leg failed")));
      } catch {
        innerRejectionCaught = true;
      }
      const nested = service.append(makeEnvelope());
      // A held append is with the writer at once, and the flush commits it.
      await drainMicrotasks();
      await scratch.writer.flush();
      nestedCallProgressed = await settlesWithin(nested, 4);
      // Abandon the nested call when it got no hold: awaiting it would hang the owner too and turn
      // a named failure into a suite-wide timeout.
      return nestedCallProgressed ? await nested : undefined;
    });

    expect(innerRejectionCaught).toBe(true);
    expect(nestedCallProgressed).toBe(true);
    expect(receipt).toMatchObject({ sequence: 0 });

    // Released exactly once, on the owner's settle: a fresh acquisition now proceeds.
    const afterOwnerSettled = sessionAppendLock.run(SESSION, () => Promise.resolve("free"));
    expect(await settlesWithin(afterOwnerSettled, 4)).toBe(true);
  });

  it("rolls the write back when a prelude statement is refused, consuming no sequence", async () => {
    const { service } = buildService();
    await scratch.writer.write([
      { sql: "CREATE TABLE prelude_probe (id TEXT PRIMARY KEY, seen_events INTEGER NOT NULL)" },
    ]);
    await service.append(makeEnvelope());

    await expect(
      service.append(makeEnvelope(), {
        transactionalPrelude: [
          { sql: "INSERT INTO prelude_probe VALUES (?, ?)", bindings: ["doomed", 1] },
          // The producer's decision-time state moved: its guard matches no row.
          {
            sql: "UPDATE prelude_probe SET seen_events = 2 WHERE seen_events = 0",
            expectedRowCount: 1,
          },
        ],
      }),
    ).rejects.toMatchObject({ statementIndex: 1, rowCount: 0 });

    // Neither half landed, and the next append re-derives its sequence from the durable head row.
    expect(scratch.reader.prepare("SELECT COUNT(*) AS c FROM prelude_probe").get()).toEqual({
      c: 0,
    });
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

const RUN_1: RunId = RunIdSchema.parse("0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f20");
const RUN_2: RunId = RunIdSchema.parse("0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f21");

type RunChangeType = (typeof TERMINAL_RUN_TYPES)[number] | "run.running";

/** A stored `run.<state>` payload its registered variant accepts, keyed by `runId` and version. */
function runChangePayload(
  type: RunChangeType,
  runId: RunId,
  runVersion: number,
): Record<string, unknown> {
  const newState = type.slice("run.".length);
  return {
    sessionId: SESSION,
    runId,
    runVersion,
    previousState: newState === "running" ? "starting" : "running",
    newState,
    ...(newState === "completed" ? { completionKind: "turn" } : {}),
  };
}

function runChangeEnvelope(
  runId: RunId,
  runVersion: number,
  type: RunChangeType = "run.completed",
): UnsequencedEventEnvelope {
  return makeEnvelope({
    category: "run_lifecycle",
    type,
    payload: runChangePayload(type, runId, runVersion),
  });
}

describe("EventLogService — terminal-key backstop", () => {
  it.each(TERMINAL_RUN_TYPES)(
    "admits the first %s for a run and refuses a second terminal of each type",
    async (firstType) => {
      const { service } = buildService();

      await service.append(runChangeEnvelope(RUN_1, 1, firstType));

      for (const secondType of TERMINAL_RUN_TYPES) {
        await expect(
          service.append(runChangeEnvelope(RUN_1, 1, secondType)),
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

    await service.append(runChangeEnvelope(RUN_1, 1));
    await expect(service.append(runChangeEnvelope(RUN_2, 1))).resolves.toMatchObject({
      sequence: 1,
    });
    await expect(service.append(runChangeEnvelope(RUN_1, 2))).resolves.toMatchObject({
      sequence: 2,
    });
  });

  it("lets a NON-terminal run_lifecycle duplicate through (index is terminal-only)", async () => {
    // `run_lifecycle` also carries non-terminal types; an index guarding the whole category would
    // refuse the ordinary progression events.
    const { service } = buildService();

    await service.append(runChangeEnvelope(RUN_1, 1, "run.running"));
    await expect(service.append(runChangeEnvelope(RUN_1, 1, "run.running"))).resolves.toMatchObject(
      { sequence: 1 },
    );
  });

  it("refuses a terminal event whose run key is missing or the wrong storage class", async () => {
    // SQLite treats NULLs as distinct in a UNIQUE index, so a terminal row with no `$.runId`
    // conflicts with nothing, and `json_extract` returns SQLite values, so a stringified
    // `runVersion` is a different key from the integer. The trigger closes both. The append path's
    // variant parse refuses these payloads first, so the rows go in beneath it.
    const valid = runChangePayload("run.completed", RUN_1, 1);
    const { runId: _runId, runVersion: _runVersion, ...keyless } = valid;
    const refusedPayloads: ReadonlyArray<Record<string, unknown>> = [
      { ...keyless, runVersion: 1 },
      { ...keyless, runId: RUN_1 },
      { ...keyless, runId: 7, runVersion: 1 },
      { ...keyless, runId: RUN_1, runVersion: "1" },
      { ...keyless, runId: RUN_1, runVersion: 1.5 },
      { ...keyless, runId: null, runVersion: 1 },
    ];

    for (const [index, payload] of refusedPayloads.entries()) {
      await expect(
        insertStoredEvent(scratch.writer, {
          id: `evt-keyless-${String(index)}`,
          sessionId: SESSION,
          sequence: index,
          occurredAt: "2026-08-04T12:00:00.000Z",
          monotonicNs: 1n,
          category: "run_lifecycle",
          type: "run.completed",
          actor: null,
          payload,
          correlationId: null,
          causationId: null,
          version: "1.0",
        }),
        `payload ${JSON.stringify(payload)} must be refused`,
      ).rejects.toThrow(/terminal run_lifecycle requires/);
    }

    expect(readRawRows(SESSION)).toHaveLength(0);
  });

  it("refuses an UPDATE promoting a committed non-terminal row into a terminal one", async () => {
    // The INSERT trigger cannot see this: a row outside the partial index's predicate is UPDATEd
    // into it. Terminal rows are INSERT-only.
    const { service } = buildService();
    const receipt = await service.append(runChangeEnvelope(RUN_1, 1, "run.running"));

    expect(() =>
      tamper
        .prepare("UPDATE session_events SET category = ?, type = ? WHERE id = ?")
        .run("run_lifecycle", "run.completed", receipt.id),
    ).toThrow(/cannot be promoted to terminal/);
  });

  it("refuses an UPDATE that moves or drops a committed terminal row's run key", async () => {
    const { service } = buildService();
    const receipt = await service.append(runChangeEnvelope(RUN_1, 1));

    // The index constrains which keys are live, not their stability: rewriting a key moves it, so
    // the index stays satisfied while the record attributes the terminal event to another run.
    // Both halves of the pair are pinned because the guard compares them independently.
    expect(() =>
      tamper
        .prepare("UPDATE session_events SET payload = ? WHERE id = ?")
        .run(JSON.stringify(runChangePayload("run.completed", RUN_2, 1)), receipt.id),
    ).toThrow(/must preserve runId/);
    expect(() =>
      tamper
        .prepare("UPDATE session_events SET payload = ? WHERE id = ?")
        .run(JSON.stringify(runChangePayload("run.completed", RUN_1, 2)), receipt.id),
    ).toThrow(/must preserve runId/);

    // Moving a row out of the partial index's predicate frees its key for reuse. `category` and
    // `type` are independent disjuncts in the guard, so each needs its own case.
    expect(() =>
      tamper
        .prepare("UPDATE session_events SET category = ? WHERE id = ?")
        .run("session_lifecycle", receipt.id),
    ).toThrow(/must preserve runId/);
    expect(() =>
      tamper
        .prepare("UPDATE session_events SET type = ? WHERE id = ?")
        .run("run.running", receipt.id),
    ).toThrow(/must preserve runId/);

    // Dropping the key makes both `json_extract` values NULL, which the value-equality check
    // cannot see and the NULL-distinct index allows, so a rewrite that forgets the run key would
    // silently reopen the duplicate-terminal bypass.
    for (const droppedPayload of [{ runVersion: 1 }, { runId: RUN_1 }, { note: "rewritten" }]) {
      expect(
        () =>
          tamper
            .prepare("UPDATE session_events SET payload = ? WHERE id = ?")
            .run(JSON.stringify(droppedPayload), receipt.id),
        `payload ${JSON.stringify(droppedPayload)} must be refused`,
      ).toThrow(/must preserve runId/);
    }

    // The row is untouched, so the backstop still holds against a real duplicate.
    await expect(service.append(runChangeEnvelope(RUN_1, 1))).rejects.toThrow(/UNIQUE/i);
  });
});
