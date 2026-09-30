// The whole-session purge stubs every purgeable row, clears its PII and sealed body, disposes the
// session's content key, and never runs inside an append-lock hold. Rows are seeded raw to sit at
// an exact sequence, under a real `EventCategory`, since the stub projection parses it.

import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DAEMON_SCOPE_SENTINEL_SESSION_ID,
  EVENT_CANONICAL_BYTES_MAX,
  NodeIdSchema,
  SessionIdSchema,
  type NodeId,
  type SessionId,
} from "@ai-sidekicks/contracts";

import { openDatabase } from "../../session/migration-runner.js";
import { __resetSessionAppendLocksForTest, withSessionAppendLock } from "../session-append-lock.js";
import type {
  SessionContentKeyDisposer,
  SessionContentKeySweepResult,
} from "../session-content-key-store.js";
import {
  AUDIT_STUB_RETENTION_CLASS,
  SessionPurge,
  type SessionPurgeEventLog,
  type SessionPurgeOutcome,
  type SessionPurgeResult,
} from "../session-purge.js";

const SESSION: SessionId = SessionIdSchema.parse("11111111-2222-4333-8444-555555555555");
const SECOND_SESSION: SessionId = SessionIdSchema.parse("11111111-2222-4333-8444-555555555556");
const NODE: NodeId = NodeIdSchema.parse("node-purge-01");
const PURGE_INSTANT = "2026-08-04T12:00:00.000Z";

/** The receipt payload members these arms read back. */
interface ReceiptPayloadShape {
  readonly removedSessions?: ReadonlyArray<{
    readonly sessionId: string;
    readonly fromSeq: number;
    readonly toSeq: number;
  }>;
}

interface RecordedEnvelope {
  readonly sessionId: SessionId;
  readonly category: string;
  readonly type: string;
  readonly payload: ReceiptPayloadShape;
}

class RecordingEventLog implements SessionPurgeEventLog {
  readonly appended: RecordedEnvelope[] = [];

  append(envelope: {
    id: string;
    sessionId: SessionId;
    category: string;
    type: string;
    payload: Record<string, unknown>;
  }): Promise<{ id: string; sequence: number }> {
    this.appended.push({ ...envelope, payload: envelope.payload as ReceiptPayloadShape });
    return Promise.resolve({ id: envelope.id, sequence: 0 });
  }
}

/** Records the per-session key disposal the purge owes. */
class RecordingContentKeyDisposer implements SessionContentKeyDisposer {
  readonly disposedSessions: string[] = [];

  async deleteIfUnreferenced(sessionId: SessionId): Promise<boolean> {
    this.disposedSessions.push(sessionId);
    return true;
  }

  async sweepUnreferenced(): Promise<SessionContentKeySweepResult> {
    throw new Error("the purge never runs the table-wide sweep");
  }
}

let database: DatabaseType;
let nextSequence: number;

beforeEach(() => {
  database = openDatabase(":memory:");
  nextSequence = 0;
  __resetSessionAppendLocksForTest();
});

afterEach(() => {
  __resetSessionAppendLocksForTest();
  database.close();
});

interface SeedOptions {
  readonly category: string;
  readonly type: string;
  readonly payload: Record<string, unknown> | string;
  readonly sessionId?: SessionId;
  readonly sequence?: number;
  /** The sealed machine-authored body, when this row carries one. */
  readonly contentPayload?: Uint8Array;
}

function seed(options: SeedOptions): { readonly id: string; readonly sequence: number } {
  const sequence = options.sequence ?? nextSequence++;
  const id = `evt-${(options.sessionId ?? SESSION).slice(-4)}-${String(sequence)}`;
  database
    .prepare(
      `INSERT INTO session_events
         (id, session_id, sequence, occurred_at, monotonic_ns, category, type, actor, payload,
          pii_payload, correlation_id, causation_id, version, pii_user_id, content_payload)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      options.sessionId ?? SESSION,
      sequence,
      "2026-08-01T00:00:00.000Z",
      BigInt(sequence + 1),
      options.category,
      options.type,
      null,
      typeof options.payload === "string" ? options.payload : JSON.stringify(options.payload),
      Buffer.from([1, 2, 3]),
      "corr-1",
      "caus-1",
      "1.0",
      "user-abc",
      options.contentPayload === undefined ? null : Buffer.from(options.contentPayload),
    );
  return { id, sequence };
}

function seedMessage(text: string): { readonly id: string; readonly sequence: number } {
  return seed({ category: "session_lifecycle", type: "session.updated", payload: { text } });
}

interface StoredEventRow {
  readonly id: string;
  readonly payload: string;
  readonly retention_class: string | null;
  readonly correlation_id: string | null;
  readonly causation_id: string | null;
  readonly pii_payload: Uint8Array | null;
  readonly pii_user_id: string | null;
  readonly content_payload: Uint8Array | null;
  readonly monotonic_ns: number;
  readonly version: string;
}

/** The stub projection as stored; optional members, since which ones survive is the question. */
interface StoredStubProjection {
  readonly id?: string;
  readonly sessionId?: string;
  readonly sequence?: number;
  readonly occurredAt?: string;
  readonly category?: string;
  readonly type?: string;
  readonly actor?: string | null;
  readonly retentionClass?: string;
  readonly purgedAt?: string;
  readonly summary?: string;
  readonly runId?: string;
  readonly runVersion?: number;
  readonly targetPosition?: number;
  readonly sourceEpoch?: number;
  readonly sourcePosition?: number;
  readonly contentLength?: number;
  readonly contentTruncated?: boolean;
  readonly extra?: unknown;
}

function readRow(id: string): StoredEventRow {
  return database.prepare("SELECT * FROM session_events WHERE id = ?").get(id) as StoredEventRow;
}

function stubProjection(id: string): StoredStubProjection {
  return JSON.parse(readRow(id).payload) as StoredStubProjection;
}

interface BuildOptions {
  readonly contentKeyDisposer?: SessionContentKeyDisposer;
  readonly eventLog?: SessionPurgeEventLog;
}

function buildPurge(options?: BuildOptions): SessionPurge {
  return new SessionPurge({
    db: database,
    nodeId: NODE,
    eventLog: options?.eventLog ?? new RecordingEventLog(),
    contentKeyDisposer: options?.contentKeyDisposer ?? new RecordingContentKeyDisposer(),
    now: () => new Date(PURGE_INSTANT),
  });
}

/**
 * The one session's outcome of a deletion that removes only it. A refusal of
 * the whole deletion has no outcome, so it fails the arm with its reason.
 */
function onlyOutcome(result: SessionPurgeResult): SessionPurgeOutcome {
  const outcome = result.outcomes[0];
  if (outcome === undefined || result.outcomes.length !== 1) {
    throw new Error(
      `expected one session outcome; the deletion said: ${String(result.refusedReason)}`,
    );
  }
  return outcome;
}

describe("SessionPurge — the whole session", () => {
  it("stubs every purgeable row and spares the maintenance rows and every other session", async () => {
    const first = seedMessage("hi");
    const maintenance = seed({
      category: "event_maintenance",
      type: "event.compacted",
      payload: { ok: true },
    });
    const newest = seedMessage("yo");
    const otherSession = seed({
      category: "session_lifecycle",
      type: "session.updated",
      payload: { text: "kept" },
      sessionId: SECOND_SESSION,
      sequence: 0,
    });

    const eventLog = new RecordingEventLog();
    const outcome: SessionPurgeOutcome = await buildPurge({ eventLog })
      .purge([SESSION])
      .then(onlyOutcome);

    expect(outcome.refusedReason).toBeUndefined();
    expect(outcome.rowsStubbed).toBe(2);
    expect(outcome.fromSequence).toBe(first.sequence);
    expect(outcome.toSequence).toBe(newest.sequence);

    for (const id of [first.id, newest.id]) {
      const stubbed = readRow(id);
      expect(stubbed.retention_class).toBe(AUDIT_STUB_RETENTION_CLASS);
      expect(stubbed.correlation_id).toBeNull();
      expect(stubbed.causation_id).toBeNull();
      expect(stubbed.pii_payload).toBeNull();
      expect(stubbed.pii_user_id).toBeNull();
    }

    // The row's own columns outside the payload are untouched.
    const stubbed = readRow(first.id);
    expect(stubbed.monotonic_ns).toBe(first.sequence + 1);
    expect(stubbed.version).toBe("1.0");

    expect(stubProjection(first.id)).toEqual({
      id: first.id,
      sessionId: SESSION,
      sequence: first.sequence,
      occurredAt: "2026-08-01T00:00:00.000Z",
      category: "session_lifecycle",
      type: "session.updated",
      actor: null,
      purgedAt: PURGE_INSTANT,
      retentionClass: AUDIT_STUB_RETENTION_CLASS,
      summary: expect.any(String) as unknown,
    });

    // The maintenance rows and every other session are untouched.
    expect(readRow(maintenance.id).retention_class).toBeNull();
    expect(readRow(otherSession.id).retention_class).toBeNull();

    // One receipt, bound to the sentinel, naming the purged session.
    expect(eventLog.appended).toHaveLength(1);
    expect(eventLog.appended[0]?.sessionId).toBe(DAEMON_SCOPE_SENTINEL_SESSION_ID);
    expect(eventLog.appended[0]?.category).toBe("event_maintenance");
    expect(eventLog.appended[0]?.type).toBe("event.compacted");
    expect(eventLog.appended[0]?.payload.removedSessions).toEqual([
      { sessionId: SESSION, fromSeq: first.sequence, toSeq: newest.sequence },
    ]);
  });
});

describe("SessionPurge — resuming a purge that stopped part way", () => {
  it("resumes a purge that stopped part way, leaving the rows it already stubbed byte-identical", async () => {
    // The first purge stops at a corrupt row after stubbing the one before it.
    const stubbedFirst = seedMessage("a");
    const corrupt = seed({ category: "session_lifecycle", type: "session.updated", payload: "[]" });
    const tail = seedMessage("c");
    const purge = buildPurge();

    const first = await purge.purge([SESSION]).then(onlyOutcome);
    expect(first.rowsStubbed).toBe(1);
    expect(first.refusedReason).toContain("not a JSON object");
    const afterFirstPurge = readRow(stubbedFirst.id);

    // Repaired, and purged again.
    database
      .prepare("UPDATE session_events SET payload = ? WHERE id = ?")
      .run(JSON.stringify({ text: "b" }), corrupt.id);
    const second = await purge.purge([SESSION]).then(onlyOutcome);

    expect(second.refusedReason).toBeUndefined();
    expect(second.rowsStubbed).toBe(2);
    // Skipped, not re-stubbed: re-stubbing would store a projection of a projection.
    expect(readRow(stubbedFirst.id).payload).toBe(afterFirstPurge.payload);
    expect(readRow(tail.id).retention_class).toBe(AUDIT_STUB_RETENTION_CLASS);
    // The second span opens above the first purge's stub.
    expect(second.fromSequence).toBe(corrupt.sequence);
  });
});

describe("SessionPurge — the stub projection", () => {
  it("keeps the run, posture, rewind and epoch members and drops the rest", async () => {
    const terminal = seed({
      category: "run_lifecycle",
      type: "run.completed",
      payload: { runId: "run-1", runVersion: 3, extra: "dropped" },
    });
    const rolledBack = seed({
      category: "run_lifecycle",
      type: "run.rolled_back",
      payload: { runId: "run-1", runVersion: 4, targetPosition: 12 },
    });
    const stamped = seed({
      category: "assistant_output",
      type: "assistant.message",
      payload: { runId: "run-1", sourceEpoch: 2, sourcePosition: 5 },
    });

    const outcome = await buildPurge().purge([SESSION]).then(onlyOutcome);

    expect(outcome.rowsStubbed).toBe(3);
    const terminalStub = stubProjection(terminal.id);
    expect(terminalStub.runId).toBe("run-1");
    expect(terminalStub.runVersion).toBe(3);
    expect(terminalStub.extra).toBeUndefined();
    expect(stubProjection(rolledBack.id).targetPosition).toBe(12);
    const stampedStub = stubProjection(stamped.id);
    expect(stampedStub.sourceEpoch).toBe(2);
    expect(stampedStub.sourcePosition).toBe(5);
  });

  it("shortens the minted summary until the stored stub sits at the ceiling", async () => {
    // A row written outside the append path's ceiling: the `type` scalar fits
    // the bound on its own and the summary, which embeds it, pushes it over.
    const oversizedType = "t".repeat(20_000);
    const target = seed({
      category: "session_lifecycle",
      type: oversizedType,
      payload: { text: "hi" },
    });

    const outcome = await buildPurge().purge([SESSION]).then(onlyOutcome);

    expect(outcome.rowsStubbed).toBe(1);
    const stubbed = readRow(target.id);
    const storedBytes = new TextEncoder().encode(stubbed.payload);
    expect(storedBytes.length).toBe(EVENT_CANONICAL_BYTES_MAX);
    const projection = stubProjection(target.id);
    expect(projection.type).toBe(oversizedType);
    const untruncatedSummary =
      `session_lifecycle/${oversizedType}: original payload discarded at purge ` +
      `(1 fields, ${String(JSON.stringify({ text: "hi" }).length)} bytes)`;
    expect(projection.summary?.length).toBeLessThan(untruncatedSummary.length);
    expect(untruncatedSummary.startsWith(projection.summary ?? "\u0000")).toBe(true);
  });

  it("refuses to stub, and leaves the row whole, when the projection stays oversized with no summary", async () => {
    // A preserved member no bound may shorten.
    const oversizedReference = "r".repeat(EVENT_CANONICAL_BYTES_MAX + 1024);
    const target = seed({
      category: "session_lifecycle",
      type: "session.updated",
      payload: { credentialPolicyRef: oversizedReference },
    });

    const outcome = await buildPurge().purge([SESSION]).then(onlyOutcome);

    expect(outcome.rowsStubbed).toBe(0);
    expect(outcome.refusedReason).toContain("EVENT_CANONICAL_BYTES_MAX");
    const row = readRow(target.id);
    expect(row.retention_class).toBeNull();
    expect(JSON.parse(row.payload)).toEqual({ credentialPolicyRef: oversizedReference });
  });
});

describe("SessionPurge — the terminal-key backstop survives the purge", () => {
  it("still refuses a second terminal for a run whose first terminal is now a stub", async () => {
    const terminal = seed({
      category: "run_lifecycle",
      type: "run.completed",
      payload: { runId: "run-terminal", runVersion: 1, extra: "dropped" },
    });

    expect((await buildPurge().purge([SESSION]).then(onlyOutcome)).rowsStubbed).toBe(1);
    expect(readRow(terminal.id).retention_class).toBe(AUDIT_STUB_RETENTION_CLASS);

    expect(() =>
      seed({
        category: "run_lifecycle",
        type: "run.completed",
        payload: { runId: "run-terminal", runVersion: 1 },
      }),
    ).toThrow(/UNIQUE/i);
  });
});

describe("SessionPurge — one receipt per deletion", () => {
  it("records the rows a refused session lost and carries on with the next session", async () => {
    // The first session stops at a corrupt row after stubbing two; the second
    // session is refused before any stub; the third purges whole. The receipt
    // names the first with the range it did stub and the third, and not the
    // second, which lost nothing.
    seedMessage("a");
    seedMessage("b");
    seed({ category: "session_lifecycle", type: "session.updated", payload: "[]" });
    seedMessage("d");
    const THIRD_SESSION: SessionId = SessionIdSchema.parse("11111111-2222-4333-8444-555555555557");
    const refusedFirstRow = seed({
      category: "session_lifecycle",
      type: "session.updated",
      payload: "[]",
      sessionId: SECOND_SESSION,
      sequence: 0,
    });
    const third = seed({
      category: "session_lifecycle",
      type: "session.updated",
      payload: { text: "third" },
      sessionId: THIRD_SESSION,
      sequence: 0,
    });
    const eventLog = new RecordingEventLog();

    const result = await buildPurge({ eventLog }).purge([SESSION, SECOND_SESSION, THIRD_SESSION]);

    expect(result.refusedReason).toBeUndefined();
    const [first, second, last] = result.outcomes;
    expect(first?.rowsStubbed).toBe(2);
    expect(first?.refusedReason).toContain("not a JSON object");
    expect(second?.rowsStubbed).toBe(0);
    expect(second?.refusedReason).toContain("not a JSON object");
    expect(last?.refusedReason).toBeUndefined();
    expect(readRow(refusedFirstRow.id).retention_class).toBeNull();
    expect(readRow(third.id).retention_class).toBe(AUDIT_STUB_RETENTION_CLASS);
    expect(eventLog.appended).toHaveLength(1);
    expect(eventLog.appended[0]?.payload.removedSessions).toEqual([
      { sessionId: SESSION, fromSeq: 0, toSeq: 1 },
      { sessionId: THIRD_SESSION, fromSeq: 0, toSeq: 0 },
    ]);
  });
});

// The arm below pins a purge that declined to run, so it is paired with a
// positive arm over the same seeds: without the pairing, "nothing was stubbed"
// passes just as well against a purge that never stubs anything.

describe("SessionPurge — a purge entered inside an append-lock hold is refused", () => {
  it("refuses under a hold on any session, and purges outside it", async () => {
    // The lock is reentrant per owner, so a purge inside a hold on the session
    // would acquire nothing for its rows.
    const candidate = seedMessage("destroyable");
    const purge = buildPurge();

    for (const heldSession of [SESSION, SECOND_SESSION]) {
      const insideHold = await withSessionAppendLock(heldSession, () => purge.purge([SESSION]));
      expect(insideHold.outcomes).toEqual([]);
      expect(insideHold.refusedReason).toContain("append-lock hold");
      expect(readRow(candidate.id).retention_class).toBeNull();
    }

    const outsideHold = await purge.purge([SESSION]).then(onlyOutcome);
    expect(outsideHold.refusedReason).toBeUndefined();
    expect(readRow(candidate.id).retention_class).toBe(AUDIT_STUB_RETENTION_CLASS);
  });
});

describe("SessionPurge — the sealed machine-authored body", () => {
  function sealedBody(byteLength: number): Uint8Array {
    return new Uint8Array(byteLength).fill(0xa7);
  }

  it("destroys the body, keeping only its shape", async () => {
    const complete = seed({
      category: "assistant_output",
      type: "assistant.message",
      payload: { runId: "run-1", contentLength: 4_096 },
      contentPayload: sealedBody(1_024),
    });
    const truncated = seed({
      category: "tool_activity",
      type: "tool.result",
      payload: {
        runId: "run-1",
        toolName: "read_file",
        contentLength: 900_000,
        contentTruncated: true,
      },
      contentPayload: sealedBody(1_024),
    });
    const bodiless = seedMessage("no body here");

    await buildPurge().purge([SESSION]).then(onlyOutcome);

    expect(readRow(complete.id).content_payload).toBeNull();
    expect(readRow(truncated.id).content_payload).toBeNull();
    expect(stubProjection(complete.id).contentLength).toBe(4_096);
    expect(stubProjection(complete.id).contentTruncated).toBeUndefined();
    expect(stubProjection(truncated.id).contentLength).toBe(900_000);
    expect(stubProjection(truncated.id).contentTruncated).toBe(true);
    expect(stubProjection(bodiless.id).contentLength).toBeUndefined();
  });
});

describe("SessionPurge — the session's content key", () => {
  it("disposes the purged session's key once, not once per row", async () => {
    const disposer = new RecordingContentKeyDisposer();
    for (const fill of [4, 5]) {
      seed({
        category: "assistant_output",
        type: "assistant.message",
        payload: { contentType: "text/markdown" },
        contentPayload: new Uint8Array(64).fill(fill),
      });
    }

    await buildPurge({ contentKeyDisposer: disposer }).purge([SESSION]).then(onlyOutcome);

    expect(disposer.disposedSessions).toEqual([SESSION]);
  });
});
