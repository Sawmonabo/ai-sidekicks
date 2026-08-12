// Contract coverage for `MerkleAnchorService` — SERVICE behaviour only
// (Plan-006 T3.3).
//
// TWO SIBLING FILES ALREADY OWN THE OTHER HALVES and are deliberately not
// repeated here: `merkle-root.test.ts` pins the pure `computeMerkleRoot`
// conformance (RFC 9162 §2.1.1 Merkle Tree Hash), and
// `daemon-credential-provider.test.ts` pins the DPoP guard and the transport's
// RFC 9449 §4.3 htm/htu agreement. What is left — and what this file is for — is
// everything that depends on the QUEUE and the CLOCK:
//
//   * the earlier-of cadence rule (1000 rows OR 300 seconds since the window's
//     own predecessor was witnessed);
//   * the coverage pre-check, in both directions: a WIDER covering anchor
//     short-circuits a force-fire, while a DISTINCT range that merely shares a
//     `start_sequence` does not collapse into it;
//   * cadence-window gap-healing, i.e. that a non-contiguous force-fire does not
//     permanently orphan the band it skipped;
//   * the drain's row dispositions — the daemon-scope sentinel exclusion, the
//     backoff gate, and the identity columns that will not bind;
//   * the backoff schedule `uploadRetryDelaySeconds` computes for that gate.
//
// ONE READING TO GET RIGHT BEFORE ADDING AN ARM: `uploadPendingAnchors()`
// returns an `AnchorDrainResult` describing work DONE on this call, never work
// REMAINING. A zero `flushed` is equally the answer when every pending row is
// still inside its backoff window, so a drain-until-zero-means-empty assertion
// would be asserting something the method does not promise. The arms below
// assert the WHOLE record rather than `flushed` alone, so every healthy path
// also pins `anchorsUnreadable: 0` — a bucket that only ever increments on the
// one row class the drain cannot record durably.
//
// Spec coverage: `Spec-006 §Anchoring Cadence` (the earlier-of rule and the
// seven-member anchor), `Spec-006 §Post-Compaction Integrity` (the coverage
// query), `Spec-006 §Daemon-Scope Event Binding And Node-Scope Anchoring` (the
// sentinel the drain excludes). Refs: Plan-006 T3.3, T3.5, I-006-3-02.

import { ed25519 } from "@noble/curves/ed25519.js";
import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DAEMON_SCOPE_SENTINEL_SESSION_ID,
  NodeIdSchema,
  SessionIdSchema,
  type AnchorPayload,
  type EventAnchorUploadResponse,
  type NodeId,
  type SessionId,
} from "@ai-sidekicks/contracts";

import { openDatabase } from "../../session/migration-runner.js";
import {
  ANCHOR_INTERVAL_EVENTS,
  ANCHOR_INTERVAL_SECONDS,
  buildAnchorClaimBytes,
  MerkleAnchorService,
  UPLOAD_RETRY_BASE_SECONDS,
  UPLOAD_RETRY_MAX_SECONDS,
  uploadRetryDelaySeconds,
  type AnchorUploadTransport,
} from "../merkle-anchor-service.js";
import type { Ed25519PrivateKey, Ed25519PublicKey } from "../signer.js";
import type { DaemonSigningKeySource } from "../signing-key-source.js";

const SESSION: SessionId = SessionIdSchema.parse("22222222-3333-4444-8555-666666666666");
const NODE: NodeId = NodeIdSchema.parse("node-anchor-0001");

const DAEMON_PRIVATE_KEY = new Uint8Array(32).fill(3) as Ed25519PrivateKey;
const DAEMON_PUBLIC_KEY = ed25519.getPublicKey(DAEMON_PRIVATE_KEY) as Ed25519PublicKey;

const keySource: DaemonSigningKeySource = {
  create: () => Promise.resolve({ publicKey: DAEMON_PUBLIC_KEY }),
  read: () => Promise.resolve(DAEMON_PRIVATE_KEY),
};

let database: DatabaseType;
// A MUTABLE clock, shared by every service built in a case. The cadence rule is
// a statement about elapsed time, and the arms that exercise it need the anchor
// written at T1 and the decision taken at T2 — which is not expressible with a
// per-service constant.
let currentInstant: Date;

beforeEach(() => {
  database = openDatabase(":memory:");
  currentInstant = new Date("2026-08-04T12:00:00.000Z");
});

afterEach(() => {
  database.close();
});

function advanceSeconds(seconds: number): void {
  currentInstant = new Date(currentInstant.getTime() + seconds * 1000);
}

/** A transport that records what it was handed and can be told to fail. */
class RecordingUploadTransport implements AnchorUploadTransport {
  readonly uploaded: AnchorPayload[] = [];
  failWith: Error | undefined;

  upload(anchor: AnchorPayload): Promise<EventAnchorUploadResponse> {
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    this.uploaded.push(anchor);
    return Promise.resolve({ stored: true });
  }
}

function buildService(transport?: AnchorUploadTransport): MerkleAnchorService {
  return new MerkleAnchorService({
    db: database,
    nodeId: NODE,
    signingKeySource: keySource,
    now: () => currentInstant,
    ...(transport !== undefined ? { uploadTransport: transport } : {}),
  });
}

/** The stored `row_hash` for a sequence — the leaf the cadence trigger must carry. */
function rowHashAt(sequence: number, sessionId: SessionId = SESSION): Uint8Array {
  const row = database
    .prepare("SELECT row_hash FROM session_events WHERE session_id = ? AND sequence = ?")
    .get(sessionId, sequence) as { row_hash: Uint8Array };
  return row.row_hash;
}

function seedEvents(count: number, sessionId: SessionId = SESSION): void {
  const insert = database.prepare(
    `INSERT INTO session_events
       (id, session_id, sequence, occurred_at, monotonic_ns, category, type, actor, payload,
        pii_payload, correlation_id, causation_id, version, prev_hash, row_hash,
        daemon_signature, pii_participant_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const insertMany = database.transaction((total: number) => {
    for (let sequence = 0; sequence < total; sequence += 1) {
      insert.run(
        `evt-${String(sessionId).slice(-4)}-${String(sequence)}`,
        sessionId,
        sequence,
        "2026-08-01T00:00:00.000Z",
        BigInt(sequence + 1),
        "session_lifecycle",
        "session.updated",
        null,
        JSON.stringify({ index: sequence }),
        null,
        null,
        null,
        "1.0",
        Buffer.alloc(32),
        // A DISTINCT leaf per row, so a Merkle root over the wrong span differs
        // from one over the right span.
        Buffer.alloc(32, (sequence % 251) + 1),
        Buffer.alloc(64, 9),
        null,
      );
    }
  });
  insertMany(count);
}

/** The durable queue row, as these arms read it back. */
interface PendingAnchorUploadRow {
  readonly session_id: string;
  readonly start_sequence: number;
  readonly end_sequence: number;
  readonly uploaded_at: string | null;
  readonly attempt_count: number;
  readonly last_error: string | null;
}

function anchorRows(): ReadonlyArray<PendingAnchorUploadRow> {
  return database
    .prepare(
      `SELECT session_id, start_sequence, end_sequence, uploaded_at, attempt_count, last_error
         FROM pending_anchor_uploads
        ORDER BY session_id, start_sequence`,
    )
    .all() as ReadonlyArray<PendingAnchorUploadRow>;
}

// ----------------------------------------------------------------------------
// I-006-3-02 — the uploaded anchor is METADATA ONLY
// ----------------------------------------------------------------------------

describe("MerkleAnchorService — the anchor carries no event content", () => {
  it("hands the transport exactly the seven metadata members and nothing else", async () => {
    seedEvents(3);
    const transport = new RecordingUploadTransport();
    const service = buildService(transport);
    await service.anchorRange({ sessionId: SESSION, fromSeq: 0, toSeq: 2 });

    expect(await service.uploadPendingAnchors()).toEqual({ flushed: 1, anchorsUnreadable: 0 });

    const [uploaded] = transport.uploaded;
    expect(uploaded).toBeDefined();
    if (uploaded === undefined) return;
    // The RUNTIME half: the value that crosses the wire has no member through
    // which event bytes could ride to the control plane.
    expect(Object.keys(uploaded).sort()).toEqual([
      "anchoredAt",
      "endSequence",
      "merkleRoot",
      "nodeId",
      "rootSignature",
      "sessionId",
      "startSequence",
    ]);

    // The TYPE half, checked by the compiler rather than at runtime: a `payload`
    // member added to `AnchorPayload` would make this directive unused and fail
    // the build. The two halves close opposite directions — a schema that
    // stopped stripping, and an interface that started declaring.
    // @ts-expect-error `AnchorPayload` declares no `payload` member (I-006-3-02).
    expect(uploaded.payload).toBeUndefined();
  });
});

// ----------------------------------------------------------------------------
// The earlier-of cadence rule — `Spec-006 §Anchoring Cadence`
// ----------------------------------------------------------------------------

describe("MerkleAnchorService — cadence (earlier of rows or seconds)", () => {
  it("writes no anchor while the window is under BOTH thresholds", async () => {
    seedEvents(5);
    const service = buildService();

    await service.onEventAppended({ sessionId: SESSION, sequence: 4, rowHash: rowHashAt(4) });

    expect(anchorRows()).toHaveLength(0);
  });

  it("fires on the ROW threshold with no time elapsed", async () => {
    seedEvents(ANCHOR_INTERVAL_EVENTS);
    const service = buildService();
    const lastSequence = ANCHOR_INTERVAL_EVENTS - 1;

    await service.onEventAppended({
      sessionId: SESSION,
      sequence: lastSequence,
      rowHash: rowHashAt(lastSequence),
    });

    expect(anchorRows()).toEqual([
      expect.objectContaining({ start_sequence: 0, end_sequence: lastSequence }),
    ]);
  });

  it("fires on the TIME threshold far below the row threshold", async () => {
    seedEvents(5);
    const service = buildService();

    // The first observation of an unwitnessed window starts its clock; there is
    // no earlier anchor to measure from.
    await service.onEventAppended({ sessionId: SESSION, sequence: 4, rowHash: rowHashAt(4) });
    expect(anchorRows()).toHaveLength(0);

    advanceSeconds(ANCHOR_INTERVAL_SECONDS + 1);
    await service.onEventAppended({ sessionId: SESSION, sequence: 4, rowHash: rowHashAt(4) });

    expect(anchorRows()).toEqual([expect.objectContaining({ start_sequence: 0, end_sequence: 4 })]);
  });

  it("measures elapsed time from the WINDOW'S OWN predecessor after a restart", async () => {
    // The reference comes from the QUEUE rather than from process state, which
    // is what closes the restart hole: a daemon that comes back with a
    // ten-minute-old anchor and one new row anchors it immediately, because
    // those seconds genuinely elapsed and that row is genuinely unwitnessed.
    seedEvents(6);
    await buildService().anchorRange({ sessionId: SESSION, fromSeq: 0, toSeq: 3 });
    advanceSeconds(ANCHOR_INTERVAL_SECONDS + 1);

    // A FRESH service — no in-process window observation survives.
    await buildService().onEventAppended({
      sessionId: SESSION,
      sequence: 5,
      rowHash: rowHashAt(5),
    });

    expect(anchorRows().map((row) => [row.start_sequence, row.end_sequence])).toEqual([
      [0, 3],
      [4, 5],
    ]);
  });

  it("heals a gap left by a non-contiguous force-fire instead of orphaning it", async () => {
    // The scenario the window walk exists for. A cadence anchor covers [0,4] at
    // T1; a compaction force-fire later covers [10,12]. `MAX(end_sequence) + 1`
    // would put the next window at 13 and the band [5,9] would never be
    // witnessed by anything. The walk stops at the first GAP, so the window
    // starts at 5.
    seedEvents(15);
    const service = buildService();
    await service.anchorRange({ sessionId: SESSION, fromSeq: 0, toSeq: 4 });

    advanceSeconds(ANCHOR_INTERVAL_SECONDS + 1);
    await service.anchorRange({ sessionId: SESSION, fromSeq: 10, toSeq: 12 });

    // The reference for the [5, …] window is the [0,4] anchor's timestamp —
    // deliberately STALE. Measuring from the newer force-fire instead would
    // restart the clock on rows that have been waiting since T1.
    await service.onEventAppended({ sessionId: SESSION, sequence: 14, rowHash: rowHashAt(14) });

    expect(anchorRows().map((row) => [row.start_sequence, row.end_sequence])).toEqual([
      [0, 4],
      [5, 14],
      [10, 12],
    ]);
  });
});

// ----------------------------------------------------------------------------
// `anchorRange` — the coverage pre-check, in both directions
// ----------------------------------------------------------------------------

describe("MerkleAnchorService — anchorRange coverage pre-check", () => {
  it("short-circuits a force-fire that a WIDER anchor already covers", async () => {
    seedEvents(10);
    const service = buildService();
    const wide = await service.anchorRange({ sessionId: SESSION, fromSeq: 0, toSeq: 9 });

    advanceSeconds(60);
    const narrow = await service.anchorRange({ sessionId: SESSION, fromSeq: 2, toSeq: 5 });

    // The COVERING anchor is returned, with its ORIGINAL timestamp — reporting
    // the fresh one would claim an anchoring that did not happen.
    expect(narrow.startSequence).toBe(0);
    expect(narrow.endSequence).toBe(9);
    expect(narrow.anchoredAt).toBe(wide.anchoredAt);
    expect(anchorRows()).toHaveLength(1);
  });

  it("does NOT collapse a distinct range that merely shares a start_sequence", async () => {
    // The queue's UNIQUE key is (session, node, start, end) precisely so a
    // cadence anchor and a wider compaction-covering anchor sharing a start can
    // coexist. Coverage is a range query, not a start-prefix match.
    seedEvents(10);
    const service = buildService();
    await service.anchorRange({ sessionId: SESSION, fromSeq: 0, toSeq: 4 });

    const wider = await service.anchorRange({ sessionId: SESSION, fromSeq: 0, toSeq: 9 });

    expect(wider.endSequence).toBe(9);
    expect(anchorRows().map((row) => [row.start_sequence, row.end_sequence])).toEqual([
      [0, 4],
      [0, 9],
    ]);
  });

  it("returns the already-queued row for an identical re-fire without re-signing", async () => {
    seedEvents(5);
    const service = buildService();
    const first = await service.anchorRange({ sessionId: SESSION, fromSeq: 0, toSeq: 4 });

    advanceSeconds(120);
    const second = await service.anchorRange({ sessionId: SESSION, fromSeq: 0, toSeq: 4 });

    expect(second).toEqual(first);
    expect(anchorRows()).toHaveLength(1);
  });

  it("refuses a range the stored rows do not fully cover", async () => {
    seedEvents(5);
    const service = buildService();

    await expect(service.anchorRange({ sessionId: SESSION, fromSeq: 0, toSeq: 9 })).rejects.toThrow(
      /expected 10/,
    );
    expect(anchorRows()).toHaveLength(0);
  });

  it("refuses a malformed range rather than committing to nothing", async () => {
    seedEvents(5);
    const service = buildService();

    await expect(service.anchorRange({ sessionId: SESSION, fromSeq: 3, toSeq: 1 })).rejects.toThrow(
      /toSeq >= fromSeq/,
    );
    await expect(
      service.anchorRange({ sessionId: SESSION, fromSeq: -1, toSeq: 2 }),
    ).rejects.toThrow(/non-negative integer bounds/);
  });

  it("signs the anchor claim — coordinates and root together — with the session's daemon key", async () => {
    seedEvents(4);
    const anchor = await buildService().anchorRange({ sessionId: SESSION, fromSeq: 0, toSeq: 3 });

    const merkleRoot = Buffer.from(anchor.merkleRoot, "base64");
    const rootSignature = Buffer.from(anchor.rootSignature, "base64");
    expect(merkleRoot).toHaveLength(32);
    expect(rootSignature).toHaveLength(64);

    // GOLDEN PIN on the preimage bytes themselves: RFC 8785 member order and
    // spellings per `Spec-006 §Anchoring Cadence` — sequences as JSON numbers,
    // merkleRoot in the upload wire's base64, ids as wire strings. A builder
    // drift (member added, renamed, re-encoded) fails here byte-for-byte.
    const claimBytes = buildAnchorClaimBytes({
      sessionId: anchor.sessionId,
      nodeId: anchor.nodeId,
      startSequence: anchor.startSequence,
      endSequence: anchor.endSequence,
      merkleRoot: new Uint8Array(merkleRoot),
    });
    expect(Buffer.from(claimBytes).toString("utf8")).toBe(
      `{"endSequence":3,"merkleRoot":"${anchor.merkleRoot}","nodeId":"${NODE}",` +
        `"sessionId":"${SESSION}","startSequence":0}`,
    );

    expect(ed25519.verify(new Uint8Array(rootSignature), claimBytes, DAEMON_PUBLIC_KEY)).toBe(true);

    // NEGATIVE CONTROL — the pre-amendment root-only preimage MUST fail. A
    // signature that also verified over the raw root would mean the claim
    // members are not actually inside the preimage, and the Spec-008 carried
    // anchor's relabeling attack is back.
    expect(
      ed25519.verify(new Uint8Array(rootSignature), new Uint8Array(merkleRoot), DAEMON_PUBLIC_KEY),
    ).toBe(false);
  });

  it("fails verification over a relabeled claim — every coordinate is inside the signature", async () => {
    seedEvents(4);
    const anchor = await buildService().anchorRange({ sessionId: SESSION, fromSeq: 0, toSeq: 3 });
    const merkleRoot = new Uint8Array(Buffer.from(anchor.merkleRoot, "base64"));
    const rootSignature = new Uint8Array(Buffer.from(anchor.rootSignature, "base64"));

    const identity = {
      sessionId: anchor.sessionId as string,
      nodeId: anchor.nodeId as string,
      startSequence: anchor.startSequence,
      endSequence: anchor.endSequence,
      merkleRoot,
    };
    const relabelings = [
      { ...identity, endSequence: anchor.endSequence + 100 }, // widened span
      { ...identity, startSequence: anchor.startSequence + 1 }, // shifted start
      { ...identity, nodeId: "node-anchor-mallory" }, // relabeled log identity
      { ...identity, sessionId: "99999999-3333-4444-8555-666666666666" }, // relabeled session
    ];
    for (const relabeled of relabelings) {
      expect(
        ed25519.verify(rootSignature, buildAnchorClaimBytes(relabeled), DAEMON_PUBLIC_KEY),
      ).toBe(false);
    }
  });
});

// ----------------------------------------------------------------------------
// `uploadPendingAnchors` — how the drain dispositions a pending row
// ----------------------------------------------------------------------------

describe("MerkleAnchorService — the upload drain", () => {
  it("never uploads a daemon-scope sentinel anchor", async () => {
    // Sentinel-partitioned rows are node-scope. They have no `sessions(id)` row
    // for `event_log_anchors` to FK against, and node-scope witnessing is a
    // V1.1 extension — so their `uploaded_at` stays NULL BY DESIGN, and this
    // filter is what keeps them from being retried forever.
    seedEvents(3);
    seedEvents(3, DAEMON_SCOPE_SENTINEL_SESSION_ID);
    const service = buildService(new RecordingUploadTransport());
    await service.anchorRange({ sessionId: SESSION, fromSeq: 0, toSeq: 2 });
    await service.anchorRange({
      sessionId: DAEMON_SCOPE_SENTINEL_SESSION_ID,
      fromSeq: 0,
      toSeq: 2,
    });

    expect(await service.uploadPendingAnchors()).toEqual({ flushed: 1, anchorsUnreadable: 0 });

    const rows = anchorRows();
    expect(rows).toHaveLength(2);
    const sentinelRow = rows.find((row) => row.session_id === DAEMON_SCOPE_SENTINEL_SESSION_ID);
    const sessionRow = rows.find((row) => row.session_id === SESSION);
    expect(sentinelRow?.uploaded_at).toBeNull();
    expect(sentinelRow?.attempt_count).toBe(0);
    expect(sessionRow?.uploaded_at).not.toBeNull();
  });

  it("records the failure durably and leaves the row pending", async () => {
    seedEvents(3);
    const transport = new RecordingUploadTransport();
    transport.failWith = new Error("control plane unreachable");
    const service = buildService(transport);
    await service.anchorRange({ sessionId: SESSION, fromSeq: 0, toSeq: 2 });

    expect(await service.uploadPendingAnchors()).toEqual({ flushed: 0, anchorsUnreadable: 0 });

    const [row] = anchorRows();
    expect(row?.uploaded_at).toBeNull();
    expect(row?.attempt_count).toBe(1);
    expect(row?.last_error).toContain("control plane unreachable");
  });

  it("skips a failed row until its backoff has elapsed, then re-attempts it", async () => {
    // THE BACKOFF GATE. Without it the durable retry state was written and never
    // read: a terminal failure would be re-attempted at the caller's full drain
    // frequency forever.
    seedEvents(3);
    const transport = new RecordingUploadTransport();
    transport.failWith = new Error("control plane unreachable");
    const service = buildService(transport);
    await service.anchorRange({ sessionId: SESSION, fromSeq: 0, toSeq: 2 });
    await service.uploadPendingAnchors();
    expect(anchorRows()[0]?.attempt_count).toBe(1);

    // Inside the window after one failed attempt — not re-selected at all, so
    // the attempt counter does not move.
    advanceSeconds(UPLOAD_RETRY_BASE_SECONDS - 1);
    expect(await service.uploadPendingAnchors()).toEqual({ flushed: 0, anchorsUnreadable: 0 });
    expect(anchorRows()[0]?.attempt_count).toBe(1);

    // Past the window, and now succeeding.
    advanceSeconds(2);
    transport.failWith = undefined;
    expect(await service.uploadPendingAnchors()).toEqual({ flushed: 1, anchorsUnreadable: 0 });
    const [row] = anchorRows();
    expect(row?.uploaded_at).not.toBeNull();
    expect(row?.attempt_count).toBe(2);
    expect(row?.last_error).toBeNull();
  });

  it("treats a never-attempted row as immediately due (the gate fails OPEN)", async () => {
    seedEvents(3);
    const transport = new RecordingUploadTransport();
    const service = buildService(transport);
    await service.anchorRange({ sessionId: SESSION, fromSeq: 0, toSeq: 2 });

    expect(await service.uploadPendingAnchors()).toEqual({ flushed: 1, anchorsUnreadable: 0 });
  });

  it("is a no-op when no transport is wired", async () => {
    seedEvents(3);
    const service = buildService();
    await service.anchorRange({ sessionId: SESSION, fromSeq: 0, toSeq: 2 });

    expect(await service.uploadPendingAnchors()).toEqual({ flushed: 0, anchorsUnreadable: 0 });
    expect(anchorRows()[0]?.attempt_count).toBe(0);
  });

  it("does not re-upload a row the control plane already stored", async () => {
    seedEvents(3);
    const transport = new RecordingUploadTransport();
    const service = buildService(transport);
    await service.anchorRange({ sessionId: SESSION, fromSeq: 0, toSeq: 2 });

    expect(await service.uploadPendingAnchors()).toEqual({ flushed: 1, anchorsUnreadable: 0 });
    // `uploaded_at` is stamped and never cleared, so the row leaves the pending
    // set permanently.
    expect(await service.uploadPendingAnchors()).toEqual({ flushed: 0, anchorsUnreadable: 0 });
    expect(transport.uploaded).toHaveLength(1);
  });

  it("counts a row whose identity will not bind, and drains the healthy ones anyway", async () => {
    // The one row class the drain cannot record durably: writing its failure to
    // `last_error` needs the same identity columns that are corrupt. It is
    // skipped — but COUNTED, because `last_error` is exactly the channel this
    // arm cannot reach, so a silent `continue` would leave the row invisible to
    // every operator surface at once.
    //
    // `start_sequence` is corrupted to a non-numeric TEXT value: SQLite's
    // INTEGER affinity converts only text that is losslessly numeric, so 'x'
    // stays TEXT and comes back from better-sqlite3 as a JS string. That is
    // what `readAnchorIdentity` refuses (`typeof !== "number"`), and it is
    // reachable at rest — the column is INTEGER NOT NULL, which constrains
    // NULL and nothing else.
    seedEvents(6);
    const transport = new RecordingUploadTransport();
    const service = buildService(transport);
    await service.anchorRange({ sessionId: SESSION, fromSeq: 0, toSeq: 2 });
    await service.anchorRange({ sessionId: SESSION, fromSeq: 3, toSeq: 5 });
    database
      .prepare("UPDATE pending_anchor_uploads SET start_sequence = 'x' WHERE start_sequence = 3")
      .run();

    expect(await service.uploadPendingAnchors()).toEqual({ flushed: 1, anchorsUnreadable: 1 });

    // The healthy row flushed — one corrupt row must not stall the queue.
    expect(transport.uploaded.map((anchor) => anchor.startSequence)).toEqual([0]);
    const healthy = anchorRows().find((row) => row.start_sequence === 0);
    expect(healthy?.uploaded_at).not.toBeNull();

    // And the corrupt row is untouched: still pending, no attempt recorded, no
    // `last_error` — which is precisely why the COUNT is the only signal.
    const corrupt = anchorRows().find((row) => String(row.start_sequence) === "x");
    expect(corrupt?.uploaded_at).toBeNull();
    expect(corrupt?.attempt_count).toBe(0);
    expect(corrupt?.last_error).toBeNull();
  });
});

// ----------------------------------------------------------------------------
// `uploadRetryDelaySeconds` — capped exponential
// ----------------------------------------------------------------------------

describe("uploadRetryDelaySeconds", () => {
  it("doubles from the base and saturates at the cap", () => {
    expect(uploadRetryDelaySeconds(1)).toBe(UPLOAD_RETRY_BASE_SECONDS);
    expect(uploadRetryDelaySeconds(2)).toBe(UPLOAD_RETRY_BASE_SECONDS * 2);
    expect(uploadRetryDelaySeconds(3)).toBe(UPLOAD_RETRY_BASE_SECONDS * 4);
    expect(uploadRetryDelaySeconds(100)).toBe(UPLOAD_RETRY_MAX_SECONDS);
    // Monotone and bounded across the whole reachable range — the property that
    // matters, rather than the value at any single attempt count.
    let previous = 0;
    for (let attempt = 1; attempt <= 40; attempt += 1) {
      const delay = uploadRetryDelaySeconds(attempt);
      expect(delay).toBeGreaterThanOrEqual(previous);
      expect(delay).toBeLessThanOrEqual(UPLOAD_RETRY_MAX_SECONDS);
      previous = delay;
    }
  });

  it("pins the LAST uncapped attempt and the FIRST capped one", () => {
    // The arm above cannot tell a working cap from a missing one: every
    // expectation in it is satisfied by the uncapped formula too, and
    // `uploadRetryDelaySeconds(100)` reaching the cap is equally what an
    // absent cap would produce via `Infinity`. THESE two values discriminate.
    // Both are literals on purpose — deriving them from the constants would
    // restate the formula under test. For the shipped 30 s base and 3600 s cap:
    //   attempt 7 → 30 * 2^6 = 1920, the last value under the cap;
    //   attempt 8 → 30 * 2^7 = 3840 uncapped, so 3600 is the cap doing work.
    // Re-derive both if either constant moves.
    expect(uploadRetryDelaySeconds(7)).toBe(1920);
    expect(uploadRetryDelaySeconds(7)).toBeLessThan(UPLOAD_RETRY_MAX_SECONDS);
    expect(uploadRetryDelaySeconds(8)).toBe(UPLOAD_RETRY_MAX_SECONDS);
    expect(uploadRetryDelaySeconds(8)).toBe(3600);
  });

  it("returns 0 for every attempt count that is not a positive number", () => {
    // The guard clause, which the arms above never reach. A corrupt
    // `attempt_count` must not yield NaN: `isUploadRetryDue` compares
    // `waited >= delay`, and every comparison against NaN is false, so a NaN
    // delay strands the row permanently instead of retrying it.
    expect(uploadRetryDelaySeconds(0)).toBe(0);
    expect(uploadRetryDelaySeconds(-1)).toBe(0);
    expect(uploadRetryDelaySeconds(Number.NaN)).toBe(0);
    expect(uploadRetryDelaySeconds(Number.POSITIVE_INFINITY)).toBe(0);
    expect(uploadRetryDelaySeconds(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it("floors a fractional attempt count rather than interpolating", () => {
    // `attempt_count` is an INTEGER column, so a fractional value is corruption
    // — but it must land on a defined rung rather than a fractional power.
    expect(uploadRetryDelaySeconds(2.9)).toBe(uploadRetryDelaySeconds(2));
  });
});
