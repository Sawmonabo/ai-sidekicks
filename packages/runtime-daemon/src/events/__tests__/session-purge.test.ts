// Coverage for `SessionPurge`, the whole-session purge behind anchors.
//
// The fixtures seed raw rows rather than appending through `EventLogService`:
// a purge is a read-modify-write over already-stored rows, and seeding places a
// row at an exact sequence with an exact payload. The integrity columns are
// fixture constants, which is honest here: nothing in this file verifies a
// chain, and the one commitment that is verified (the `stub_signature` the
// purge mints) is checked against a real Ed25519 public key. The whole-chain
// verification lives in `purge-safety-e2e.test.ts`.
//
// The `category` column must hold a real `EventCategory` member: the stub
// projection parses it, so an invented category turns every arm into a refusal.

import { ed25519 } from "@noble/curves/ed25519.js";
import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DAEMON_SCOPE_SENTINEL_SESSION_ID,
  EVENT_CANONICAL_BYTES_MAX,
  NodeIdSchema,
  SessionIdSchema,
  type AnchorPayload,
  type NodeId,
  type SessionId,
} from "@ai-sidekicks/contracts";

import { openDatabase } from "../../session/migration-runner.js";
import type { IngestHaltSource } from "../ingest-halt-source.js";
import { MerkleAnchorService } from "../merkle-anchor-service.js";
import { __resetSessionAppendLocksForTest, withSessionAppendLock } from "../session-append-lock.js";
import type {
  SessionContentKeyDisposer,
  SessionContentKeySweepResult,
} from "../session-content-key-store.js";
import {
  AUDIT_STUB_RETENTION_CLASS,
  SessionPurge,
  type SessionPurgeAnchorSource,
  type SessionPurgeEventLog,
  type SessionPurgeOutcome,
  type SessionPurgeResult,
} from "../session-purge.js";
import type { Ed25519PrivateKey, Ed25519PublicKey } from "../signer.js";
import type { DaemonSigningKeySource } from "../signing-key-source.js";

const SESSION: SessionId = SessionIdSchema.parse("11111111-2222-4333-8444-555555555555");
const SECOND_SESSION: SessionId = SessionIdSchema.parse("11111111-2222-4333-8444-555555555556");
const NODE: NodeId = NodeIdSchema.parse("node-purge-01");
const PURGE_INSTANT = "2026-08-04T12:00:00.000Z";

const DAEMON_PRIVATE_KEY = new Uint8Array(32).fill(7) as Ed25519PrivateKey;
const DAEMON_PUBLIC_KEY = ed25519.getPublicKey(DAEMON_PRIVATE_KEY) as Ed25519PublicKey;

// Answers for every session id, the sentinel included: the receipt is
// sentinel-bound.
const keySource: DaemonSigningKeySource = {
  create: () => Promise.resolve({ publicKey: DAEMON_PUBLIC_KEY }),
  read: () => Promise.resolve(DAEMON_PRIVATE_KEY),
};

// Every real session's key resolves and the sentinel's does not, as on a daemon
// whose sentinel key was never provisioned (`read` is not create-on-read).
const SENTINEL_KEY_ABSENT_MESSAGE = "no signing key row for the daemon-scope sentinel";
const sentinelLessKeySource: DaemonSigningKeySource = {
  create: () => Promise.resolve({ publicKey: DAEMON_PUBLIC_KEY }),
  read: (sessionId: SessionId) =>
    sessionId === DAEMON_SCOPE_SENTINEL_SESSION_ID
      ? Promise.reject(new Error(SENTINEL_KEY_ABSENT_MESSAGE))
      : Promise.resolve(DAEMON_PRIVATE_KEY),
};

/** An anchor source that records its calls and can be told to misbehave. */
class RecordingAnchorSource implements SessionPurgeAnchorSource {
  readonly calls: Array<{ readonly fromSeq: number; readonly toSeq: number }> = [];
  fail = false;
  /** Return an anchor that starts one sequence above the requested span. */
  narrow = false;

  anchorRange(request: {
    sessionId: SessionId;
    fromSeq: number;
    toSeq: number;
  }): Promise<AnchorPayload> {
    this.calls.push({ fromSeq: request.fromSeq, toSeq: request.toSeq });
    if (this.fail) return Promise.reject(new Error("force-fire failed"));
    const payload: AnchorPayload = {
      sessionId: request.sessionId,
      nodeId: NODE,
      startSequence: this.narrow ? request.fromSeq + 1 : request.fromSeq,
      endSequence: request.toSeq,
      merkleRoot: Buffer.alloc(32).toString("base64"),
      rootSignature: Buffer.alloc(64).toString("base64"),
      anchoredAt: PURGE_INSTANT,
    };
    return Promise.resolve(payload);
  }
}

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
  }): Promise<{ id: string; sequence: number; rowHash: Uint8Array }> {
    this.appended.push({ ...envelope, payload: envelope.payload as ReceiptPayloadShape });
    return Promise.resolve({ id: envelope.id, sequence: 0, rowHash: new Uint8Array(32) });
  }
}

/** Records the per-session key disposal the purge owes. */
class RecordingContentKeyDisposer implements SessionContentKeyDisposer {
  readonly disposedSessions: string[] = [];
  failure: Error | undefined;

  async deleteIfUnreferenced(sessionId: SessionId): Promise<boolean> {
    this.disposedSessions.push(sessionId);
    if (this.failure !== undefined) {
      throw this.failure;
    }
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
          pii_payload, correlation_id, causation_id, version, prev_hash, row_hash,
          daemon_signature, pii_user_id, content_payload)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
      Buffer.alloc(32),
      Buffer.alloc(32, sequence + 1),
      Buffer.alloc(64, 9),
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
  readonly stub_signature: Uint8Array | null;
  readonly correlation_id: string | null;
  readonly causation_id: string | null;
  readonly pii_payload: Uint8Array | null;
  readonly pii_user_id: string | null;
  readonly content_payload: Uint8Array | null;
  readonly prev_hash: Uint8Array;
  readonly row_hash: Uint8Array;
  readonly daemon_signature: Uint8Array;
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
  readonly contentCiphertextDigest?: string;
  readonly extra?: unknown;
}

function readRow(id: string): StoredEventRow {
  return database.prepare("SELECT * FROM session_events WHERE id = ?").get(id) as StoredEventRow;
}

function stubProjection(id: string): StoredStubProjection {
  return JSON.parse(readRow(id).payload) as StoredStubProjection;
}

function anchorRows(): ReadonlyArray<{ start_sequence: number; end_sequence: number }> {
  return database
    .prepare(
      "SELECT start_sequence, end_sequence FROM pending_anchor_uploads ORDER BY start_sequence",
    )
    .all() as ReadonlyArray<{ start_sequence: number; end_sequence: number }>;
}

function realAnchorService(): MerkleAnchorService {
  return new MerkleAnchorService({
    db: database,
    nodeId: NODE,
    signingKeySource: keySource,
    now: () => new Date(PURGE_INSTANT),
  });
}

interface BuildOptions {
  readonly anchorSource?: SessionPurgeAnchorSource;
  readonly contentKeyDisposer?: SessionContentKeyDisposer;
  readonly eventLog?: SessionPurgeEventLog;
  readonly signingKeySource?: DaemonSigningKeySource;
  readonly haltSource?: IngestHaltSource;
}

function buildPurge(options?: BuildOptions): SessionPurge {
  return new SessionPurge({
    db: database,
    nodeId: NODE,
    signingKeySource: options?.signingKeySource ?? keySource,
    eventLog: options?.eventLog ?? new RecordingEventLog(),
    anchorSource: options?.anchorSource ?? new RecordingAnchorSource(),
    contentKeyDisposer: options?.contentKeyDisposer ?? new RecordingContentKeyDisposer(),
    now: () => new Date(PURGE_INSTANT),
    ...(options?.haltSource !== undefined ? { haltSource: options.haltSource } : {}),
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
  it("stubs every purgeable row, spares the audit skeleton and mints verifiable stubs", async () => {
    const first = seedMessage("hi");
    const audit = seed({
      category: "audit_integrity",
      type: "audit_integrity_verified",
      payload: { ok: true },
    });
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

    const anchorSource = new RecordingAnchorSource();
    const eventLog = new RecordingEventLog();
    const outcome: SessionPurgeOutcome = await buildPurge({ anchorSource, eventLog })
      .purge([SESSION])
      .then(onlyOutcome);

    expect(outcome.refusedReason).toBeUndefined();
    expect(outcome.rowsStubbed).toBe(2);
    expect(outcome.fromSequence).toBe(first.sequence);
    expect(outcome.toSequence).toBe(newest.sequence);
    // Anchored over the whole span before any row was mutated.
    expect(anchorSource.calls).toEqual([{ fromSeq: first.sequence, toSeq: newest.sequence }]);

    for (const id of [first.id, newest.id]) {
      const stubbed = readRow(id);
      expect(stubbed.retention_class).toBe(AUDIT_STUB_RETENTION_CLASS);
      expect(stubbed.correlation_id).toBeNull();
      expect(stubbed.causation_id).toBeNull();
      expect(stubbed.pii_payload).toBeNull();
      expect(stubbed.pii_user_id).toBeNull();
      // `stub_signature` verifies over the exact stored bytes.
      expect(
        ed25519.verify(
          new Uint8Array(stubbed.stub_signature ?? new Uint8Array()),
          new TextEncoder().encode(stubbed.payload),
          DAEMON_PUBLIC_KEY,
        ),
      ).toBe(true);
    }

    // The chain commitments are frozen: a stub whose `row_hash` moved would
    // break every anchor that already committed to it.
    const stubbed = readRow(first.id);
    expect(stubbed.prev_hash).toEqual(Buffer.alloc(32));
    expect(stubbed.row_hash).toEqual(Buffer.alloc(32, first.sequence + 1));
    expect(stubbed.daemon_signature).toEqual(Buffer.alloc(64, 9));
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

    // The audit skeleton and every other session are untouched.
    expect(readRow(audit.id).retention_class).toBeNull();
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

  it("does nothing, anchors nothing and records nothing for a session with nothing left to purge", async () => {
    seed({ category: "audit_integrity", type: "audit_integrity_verified", payload: { ok: true } });
    const anchorSource = new RecordingAnchorSource();
    const eventLog = new RecordingEventLog();
    const disposer = new RecordingContentKeyDisposer();

    const outcome = await buildPurge({
      anchorSource,
      eventLog,
      contentKeyDisposer: disposer,
    })
      .purge([SESSION])
      .then(onlyOutcome);

    expect(outcome).toEqual({ sessionId: SESSION, rowsStubbed: 0 });
    expect(anchorSource.calls).toHaveLength(0);
    expect(eventLog.appended).toHaveLength(0);
    expect(disposer.disposedSessions).toEqual([]);
  });
});

describe("SessionPurge — anchor before destruction", () => {
  it("refuses with nothing mutated when the force-fire fails", async () => {
    const row = seedMessage("hi");
    const anchorSource = new RecordingAnchorSource();
    anchorSource.fail = true;

    const outcome = await buildPurge({ anchorSource }).purge([SESSION]).then(onlyOutcome);

    expect(outcome.rowsStubbed).toBe(0);
    expect(outcome.refusedReason).toContain("force-fire failed");
    expect(readRow(row.id).retention_class).toBeNull();
    expect(readRow(row.id).correlation_id).toBe("corr-1");
  });

  it("refuses when the returned anchor does not cover the whole span", async () => {
    const row = seedMessage("hi");
    seedMessage("ho");
    const anchorSource = new RecordingAnchorSource();
    anchorSource.narrow = true;

    const outcome = await buildPurge({ anchorSource }).purge([SESSION]).then(onlyOutcome);

    expect(outcome.refusedReason).toContain("does not cover");
    expect(outcome.rowsStubbed).toBe(0);
    expect(readRow(row.id).retention_class).toBeNull();
  });
});

describe("SessionPurge — against the real MerkleAnchorService", () => {
  it("anchors a span containing an interleaved never-purged row", async () => {
    const first = seedMessage("a");
    const audit = seed({
      category: "audit_integrity",
      type: "audit_integrity_verified",
      payload: { ok: true },
    });
    const last = seedMessage("b");

    const outcome = await buildPurge({ anchorSource: realAnchorService() })
      .purge([SESSION])
      .then(onlyOutcome);

    expect(outcome.refusedReason).toBeUndefined();
    expect(outcome.rowsStubbed).toBe(2);
    expect(readRow(first.id).retention_class).toBe(AUDIT_STUB_RETENTION_CLASS);
    expect(readRow(last.id).retention_class).toBe(AUDIT_STUB_RETENTION_CLASS);
    expect(readRow(audit.id).retention_class).toBeNull();
    expect(anchorRows()).toEqual([{ start_sequence: 0, end_sequence: last.sequence }]);
  });

  it("resumes a purge that stopped part way, leaving the rows it already stubbed byte-identical", async () => {
    // The first purge stops at a corrupt row after stubbing the one before it.
    const stubbedFirst = seedMessage("a");
    const corrupt = seed({ category: "session_lifecycle", type: "session.updated", payload: "[]" });
    const tail = seedMessage("c");
    const anchorService = realAnchorService();

    const first = await buildPurge({ anchorSource: anchorService })
      .purge([SESSION])
      .then(onlyOutcome);
    expect(first.rowsStubbed).toBe(1);
    expect(first.refusedReason).toContain("not a JSON object");
    const afterFirstPurge = readRow(stubbedFirst.id);

    // Repaired, and purged again.
    database
      .prepare("UPDATE session_events SET payload = ? WHERE id = ?")
      .run(JSON.stringify({ text: "b" }), corrupt.id);
    const second = await buildPurge({ anchorSource: anchorService })
      .purge([SESSION])
      .then(onlyOutcome);

    expect(second.refusedReason).toBeUndefined();
    expect(second.rowsStubbed).toBe(2);
    // Skipped, not re-stubbed: re-stubbing would sign a projection of a projection.
    expect(readRow(stubbedFirst.id).payload).toBe(afterFirstPurge.payload);
    expect(readRow(stubbedFirst.id).stub_signature).toEqual(afterFirstPurge.stub_signature);
    expect(readRow(tail.id).retention_class).toBe(AUDIT_STUB_RETENTION_CLASS);
    // The second span opens above the first purge's stub, and the first purge's
    // anchor already covers it, so no second anchor is queued.
    expect(second.fromSequence).toBe(corrupt.sequence);
    expect(anchorRows()).toEqual([{ start_sequence: 0, end_sequence: tail.sequence }]);
  });

  it("refuses when a row inside the span is missing (density broken on purpose)", async () => {
    // The negative control for the arms above: they pass because the span is
    // dense. Break that and the real `anchorRange` must refuse.
    const first = seedMessage("a");
    const hole = seedMessage("b");
    const third = seedMessage("c");
    database.prepare("DELETE FROM session_events WHERE id = ?").run(hole.id);

    const outcome = await buildPurge({ anchorSource: realAnchorService() })
      .purge([SESSION])
      .then(onlyOutcome);

    expect(outcome.rowsStubbed).toBe(0);
    expect(outcome.refusedReason).toContain("expected");
    expect(readRow(first.id).retention_class).toBeNull();
    expect(readRow(third.id).retention_class).toBeNull();
    expect(anchorRows()).toHaveLength(0);
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

  it("shortens the minted summary until the stored stub sits at the ceiling, and signs those bytes", async () => {
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
    expect(
      ed25519.verify(
        new Uint8Array(stubbed.stub_signature ?? new Uint8Array()),
        storedBytes,
        DAEMON_PUBLIC_KEY,
      ),
    ).toBe(true);
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
    expect(row.stub_signature).toBeNull();
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

  it("refuses an UPDATE that rewrites a purged terminal row's run identity", async () => {
    const terminal = seed({
      category: "run_lifecycle",
      type: "run.completed",
      payload: { runId: "run-terminal", runVersion: 1 },
    });

    expect((await buildPurge().purge([SESSION]).then(onlyOutcome)).rowsStubbed).toBe(1);

    expect(() =>
      database
        .prepare("UPDATE session_events SET payload = ? WHERE id = ?")
        .run(JSON.stringify({ runId: "run-other", runVersion: 1 }), terminal.id),
    ).toThrow(/preserve runId/);
  });
});

describe("SessionPurge — one receipt per deletion", () => {
  it("names every session the deletion removed, each with the range it stubbed", async () => {
    // Different ranges per session, and a never-purged row at each end of the
    // first, so a receipt built from the anchored span or from one session's
    // range reads differently from the stubbed ranges.
    seed({ category: "audit_integrity", type: "audit_integrity_verified", payload: { ok: true } });
    seedMessage("a");
    seedMessage("b");
    seed({ category: "audit_integrity", type: "audit_integrity_verified", payload: { ok: true } });
    for (const sequence of [0, 1, 2, 3, 4]) {
      seed({
        category: "session_lifecycle",
        type: "session.updated",
        payload: { text: "second" },
        sessionId: SECOND_SESSION,
        sequence,
      });
    }
    const eventLog = new RecordingEventLog();

    const result = await buildPurge({ eventLog }).purge([SESSION, SECOND_SESSION]);

    expect(result.refusedReason).toBeUndefined();
    expect(result.outcomes.map((outcome) => outcome.rowsStubbed)).toEqual([2, 5]);
    expect(eventLog.appended).toHaveLength(1);
    expect(eventLog.appended[0]?.payload.removedSessions).toEqual([
      { sessionId: SESSION, fromSeq: 1, toSeq: 2 },
      { sessionId: SECOND_SESSION, fromSeq: 0, toSeq: 4 },
    ]);
  });

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
    const halted = seed({
      category: "session_lifecycle",
      type: "session.updated",
      payload: { text: "halted" },
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

    const result = await buildPurge({
      eventLog,
      haltSource: { isHalted: (sessionId: SessionId) => sessionId === SECOND_SESSION },
    }).purge([SESSION, SECOND_SESSION, THIRD_SESSION]);

    expect(result.refusedReason).toBeUndefined();
    const [first, second, last] = result.outcomes;
    expect(first?.rowsStubbed).toBe(2);
    expect(first?.refusedReason).toContain("not a JSON object");
    expect(second?.rowsStubbed).toBe(0);
    expect(second?.refusedReason).toContain("halted");
    expect(last?.refusedReason).toBeUndefined();
    expect(readRow(halted.id).retention_class).toBeNull();
    expect(readRow(third.id).retention_class).toBe(AUDIT_STUB_RETENTION_CLASS);
    expect(eventLog.appended).toHaveLength(1);
    expect(eventLog.appended[0]?.payload.removedSessions).toEqual([
      { sessionId: SESSION, fromSeq: 0, toSeq: 1 },
      { sessionId: THIRD_SESSION, fromSeq: 0, toSeq: 0 },
    ]);
  });

  it("reports a failed receipt append on the deletion without losing the rows it stubbed", async () => {
    const row = seedMessage("a");
    const eventLog: SessionPurgeEventLog = {
      append: () => Promise.reject(new Error("sentinel chain is locked")),
    };

    const result = await buildPurge({ eventLog }).purge([SESSION]);

    expect(onlyOutcome(result).rowsStubbed).toBe(1);
    expect(readRow(row.id).retention_class).toBe(AUDIT_STUB_RETENTION_CLASS);
    expect(result.refusedReason).toContain("purge receipt append failed");
    expect(result.refusedReason).toContain("sentinel chain is locked");
  });
});

// Every arm below pins a purge that declined to run, so each is paired with a
// positive arm over the same seeds: without the pairing, "nothing was stubbed"
// passes just as well against a purge that never stubs anything.

describe("SessionPurge — the sentinel signing key is probed before any row is mutated", () => {
  it("refuses with zero rows mutated and zero anchors forced", async () => {
    const candidate = seedMessage("destroyable");
    const originalPayload = readRow(candidate.id).payload;
    const anchorSource = new RecordingAnchorSource();
    const eventLog = new RecordingEventLog();

    const result = await buildPurge({
      anchorSource,
      eventLog,
      signingKeySource: sentinelLessKeySource,
    }).purge([SESSION, SECOND_SESSION]);

    expect(result.outcomes).toEqual([]);
    const stored = readRow(candidate.id);
    expect(stored.payload).toBe(originalPayload);
    expect(stored.retention_class).toBeNull();
    expect(stored.pii_payload).not.toBeNull();
    // Before the anchor, not merely before the row loop.
    expect(anchorSource.calls).toHaveLength(0);
    expect(eventLog.appended).toHaveLength(0);
    expect(result.refusedReason).toContain("sentinel");
    expect(result.refusedReason).toContain(SENTINEL_KEY_ABSENT_MESSAGE);
  });

  it("never renders key material into the refusal", async () => {
    seedMessage("destroyable");

    const result = await buildPurge({ signingKeySource: sentinelLessKeySource }).purge([SESSION]);

    const reason = result.refusedReason ?? "";
    expect(reason.length).toBeGreaterThan(0);
    const secret = Buffer.from(DAEMON_PRIVATE_KEY);
    expect(reason).not.toContain(secret.toString("hex"));
    expect(reason).not.toContain(secret.toString("base64"));
    expect(reason).not.toContain(DAEMON_PRIVATE_KEY.join(","));
  });

  it("purges the same seeds once the sentinel key resolves", async () => {
    const candidate = seedMessage("destroyable");
    const anchorSource = new RecordingAnchorSource();
    const eventLog = new RecordingEventLog();

    const outcome = await buildPurge({ anchorSource, eventLog }).purge([SESSION]).then(onlyOutcome);

    expect(outcome.refusedReason).toBeUndefined();
    expect(readRow(candidate.id).retention_class).toBe(AUDIT_STUB_RETENTION_CLASS);
    expect(anchorSource.calls).toHaveLength(1);
    expect(eventLog.appended).toHaveLength(1);
  });
});

describe("SessionPurge — a halted session is refused", () => {
  it("refuses a halted session with nothing mutated, and purges it once the halt clears", async () => {
    // Signing a stub is attestation under the key the halt declared repudiable.
    const candidate = seedMessage("halted-candidate");
    const anchorSource = new RecordingAnchorSource();
    let halted = true;
    const purge = buildPurge({
      anchorSource,
      haltSource: { isHalted: (sessionId: SessionId) => halted && sessionId === SESSION },
    });

    const duringHalt = await purge.purge([SESSION]).then(onlyOutcome);
    expect(duringHalt.rowsStubbed).toBe(0);
    expect(duringHalt.refusedReason).toContain("halted");
    expect(readRow(candidate.id).retention_class).toBeNull();
    expect(anchorSource.calls).toHaveLength(0);

    halted = false;
    const afterHalt = await purge.purge([SESSION]).then(onlyOutcome);
    expect(afterHalt.refusedReason).toBeUndefined();
    expect(readRow(candidate.id).retention_class).toBe(AUDIT_STUB_RETENTION_CLASS);
  });

  it("refuses when the halt source itself throws", async () => {
    const candidate = seedMessage("candidate");

    const outcome = await buildPurge({
      haltSource: {
        isHalted: (): boolean => {
          throw new Error("halt registry unavailable");
        },
      },
    })
      .purge([SESSION])
      .then(onlyOutcome);

    expect(outcome.refusedReason).toContain("halt registry unavailable");
    expect(readRow(candidate.id).retention_class).toBeNull();
  });
});

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

  it("destroys the body and drops its binding claim, keeping only its shape", async () => {
    const complete = seed({
      category: "assistant_output",
      type: "assistant.message",
      payload: { runId: "run-1", contentLength: 4_096, contentCiphertextDigest: "a".repeat(64) },
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
        contentCiphertextDigest: "b".repeat(64),
      },
      contentPayload: sealedBody(1_024),
    });
    const bodiless = seedMessage("no body here");

    await buildPurge().purge([SESSION]).then(onlyOutcome);

    expect(readRow(complete.id).content_payload).toBeNull();
    expect(readRow(truncated.id).content_payload).toBeNull();
    // The digest committed to bytes the purge destroyed.
    expect(stubProjection(complete.id).contentCiphertextDigest).toBeUndefined();
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

  it("does not dispose when the purge stubbed nothing", async () => {
    const disposer = new RecordingContentKeyDisposer();
    seedMessage("kept");
    const anchorSource = new RecordingAnchorSource();
    anchorSource.fail = true;

    await buildPurge({ anchorSource, contentKeyDisposer: disposer })
      .purge([SESSION])
      .then(onlyOutcome);

    expect(disposer.disposedSessions).toEqual([]);
  });

  it("reports a failed disposal without losing the rows it stubbed", async () => {
    const disposer = new RecordingContentKeyDisposer();
    disposer.failure = new Error("content-key table is locked");
    const row = seed({
      category: "assistant_output",
      type: "assistant.message",
      payload: { contentType: "text/markdown" },
      contentPayload: new Uint8Array(32).fill(6),
    });

    const outcome = await buildPurge({ contentKeyDisposer: disposer })
      .purge([SESSION])
      .then(onlyOutcome);

    expect(outcome.rowsStubbed).toBe(1);
    expect(readRow(row.id).content_payload).toBeNull();
    expect(outcome.refusedReason).toContain("content-key disposal failed");
    expect(outcome.refusedReason).toContain("content-key table is locked");
  });
});
