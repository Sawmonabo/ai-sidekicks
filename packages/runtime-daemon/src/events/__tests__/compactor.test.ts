// Coverage for `Compactor`, the background maintenance pass.
//
// The first block is the property the pass exists under: nothing in the
// background removes or rewrites a transcript row. It runs the real content-key
// store over a real table holding rows that are old, many and body-bearing,
// every shape a retention trigger once chose to destroy. The remaining blocks
// pin the pass's own guards and its report, against a recording key store.

import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SessionIdSchema, type SessionId } from "@ai-sidekicks/contracts";

import { openDatabase } from "../../session/migration-runner.js";
import { Compactor, type CompactionPassResult } from "../compactor.js";
import { __resetSessionAppendLocksForTest, withSessionAppendLock } from "../session-append-lock.js";
import {
  SessionContentKeyStore,
  type SessionContentKeyDisposer,
  type SessionContentKeySweepResult,
} from "../session-content-key-store.js";

const KEPT_SESSION: SessionId = SessionIdSchema.parse("11111111-2222-4333-8444-555555555555");
const ABANDONED_KEY_SESSION: SessionId = SessionIdSchema.parse(
  "11111111-2222-4333-8444-555555555556",
);

let database: DatabaseType;

beforeEach(() => {
  database = openDatabase(":memory:");
  __resetSessionAppendLocksForTest();
});

afterEach(() => {
  __resetSessionAppendLocksForTest();
  database.close();
});

/** One macrotask, later than every pending microtask. */
function nextMacrotask(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

function seedRow(options: {
  readonly sessionId: SessionId;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly category: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly contentPayload?: Uint8Array;
}): void {
  database
    .prepare(
      `INSERT INTO session_events
         (id, session_id, sequence, occurred_at, monotonic_ns, category, type, actor, payload,
          pii_payload, correlation_id, causation_id, version, pii_user_id, content_payload)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      `evt-${options.sessionId.slice(-4)}-${String(options.sequence)}`,
      options.sessionId,
      options.sequence,
      options.occurredAt,
      BigInt(options.sequence + 1),
      options.category,
      options.type,
      null,
      JSON.stringify(options.payload),
      Buffer.from([1, 2, 3]),
      "corr-1",
      "caus-1",
      "1.0",
      "user-abc",
      options.contentPayload === undefined ? null : Buffer.from(options.contentPayload),
    );
}

function allEventRows(): readonly unknown[] {
  return database.prepare("SELECT * FROM session_events ORDER BY session_id, sequence").all();
}

function contentKeySessions(): readonly string[] {
  return (
    database
      .prepare("SELECT session_id FROM session_content_keys ORDER BY session_id")
      .all() as ReadonlyArray<{ readonly session_id: string }>
  ).map((row) => row.session_id);
}

describe("Compactor — nothing in the background removes a transcript row", () => {
  it("leaves every row of an old, long, body-bearing session byte-identical and keeps its key", async () => {
    const keyStore = new SessionContentKeyStore({
      database,
      masterKeySource: { read: async (): Promise<Uint8Array> => new Uint8Array(32).fill(11) },
    });
    // The kept session's key seals the bodies below; the other session's key
    // seals nothing, which is the one thing the pass may retire.
    await keyStore.resolveForWrite(KEPT_SESSION);
    await keyStore.resolveForWrite(ABANDONED_KEY_SESSION);

    // Years old, far past any age a retention trigger measured, with message,
    // reasoning and tool rows whose bodies and PII the screen draws.
    const transcriptTypes = [
      { category: "session_lifecycle", type: "session.created" },
      { category: "assistant_output", type: "assistant.message" },
      { category: "assistant_output", type: "assistant.reasoning" },
      { category: "tool_activity", type: "tool.result" },
    ] as const;
    for (let sequence = 0; sequence < 40; sequence += 1) {
      const shape = transcriptTypes[sequence % transcriptTypes.length] ?? transcriptTypes[0];
      seedRow({
        sessionId: KEPT_SESSION,
        sequence,
        occurredAt: "2019-03-01T00:00:00.000Z",
        category: shape.category,
        type: shape.type,
        payload: { runId: "run-1", contentLength: 4_096 },
        contentPayload: new Uint8Array(4_096).fill(sequence % 251),
      });
    }
    const before = allEventRows();

    const compactor = new Compactor({ contentKeyDisposer: keyStore });
    const first = await compactor.tick();
    const second = await compactor.tick();

    expect(allEventRows()).toEqual(before);
    expect(contentKeySessions()).toEqual([KEPT_SESSION]);
    expect(first.contentKeysReclaimed).toBe(1);
    expect(second.contentKeysReclaimed).toBe(0);
  });
});

/**
 * Records the sweep. The store's own predicate and race safety are pinned
 * against a real table in `session-content-partition.test.ts`; what is under
 * test here is the pass around it.
 */
class RecordingContentKeyDisposer implements SessionContentKeyDisposer {
  sweeps = 0;
  sweepFailure: Error | undefined;
  reclaims = 0;
  skips = 0;
  /** When set, the sweep waits on it, so a test can hold a pass in flight. */
  parked: Promise<void> | undefined;

  async deleteIfUnreferenced(): Promise<boolean> {
    throw new Error("the compactor never disposes one session's key");
  }

  async sweepUnreferenced(): Promise<SessionContentKeySweepResult> {
    this.sweeps += 1;
    if (this.parked !== undefined) {
      await this.parked;
    }
    if (this.sweepFailure !== undefined) {
      throw this.sweepFailure;
    }
    return { reclaimed: this.reclaims, skipped: this.skips };
  }
}

describe("Compactor — the content-key sweep", () => {
  it("reports what the sweep reclaimed and passed over", async () => {
    const disposer = new RecordingContentKeyDisposer();
    disposer.reclaims = 2;
    disposer.skips = 1;

    const result: CompactionPassResult = await new Compactor({
      contentKeyDisposer: disposer,
    }).tick();

    expect(disposer.sweeps).toBe(1);
    expect(result).toEqual({ contentKeysReclaimed: 2, contentKeysSkipped: 1 });
  });

  it("reports a failing sweep instead of throwing", async () => {
    const disposer = new RecordingContentKeyDisposer();
    disposer.sweepFailure = new Error("reconciliation query failed");

    const result = await new Compactor({ contentKeyDisposer: disposer }).tick();

    expect(result.contentKeysReclaimed).toBe(0);
    expect(result.contentKeySweepFailure).toContain("reconciliation query failed");
  });

  it("distinguishes a sweep that found nothing from one that reclaimed nothing", async () => {
    // A sweep whose candidates all threw ran, raised no failure of its own and
    // reclaimed zero, exactly what an idle pass reports; only the skip count
    // tells them apart.
    const idleResult = await new Compactor({
      contentKeyDisposer: new RecordingContentKeyDisposer(),
    }).tick();
    const stuck = new RecordingContentKeyDisposer();
    stuck.skips = 3;
    const stuckResult = await new Compactor({ contentKeyDisposer: stuck }).tick();

    expect(idleResult).toEqual({ contentKeysReclaimed: 0, contentKeysSkipped: 0 });
    expect(stuckResult).toEqual({ contentKeysReclaimed: 0, contentKeysSkipped: 3 });
    expect(Object.hasOwn(idleResult, "contentKeySweepFailure")).toBe(false);
  });
});

describe("Compactor — the tick's guards", () => {
  it("returns an empty result from a tick entered while another is in flight", async () => {
    const disposer = new RecordingContentKeyDisposer();
    disposer.reclaims = 1;
    let release!: () => void;
    disposer.parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const compactor = new Compactor({ contentKeyDisposer: disposer });

    const firstTick = compactor.tick();
    await nextMacrotask();
    const reentrant = await compactor.tick();

    expect(reentrant).toEqual({ contentKeysReclaimed: 0, contentKeysSkipped: 0 });
    expect(disposer.sweeps).toBe(1);

    release();
    expect((await firstTick).contentKeysReclaimed).toBe(1);
  });

  it("does nothing when entered inside an append-lock hold", async () => {
    // The sweep takes each session's append lock, and the lock is reentrant per
    // owner, so a sweep inside a hold would acquire nothing for that session.
    const disposer = new RecordingContentKeyDisposer();
    const compactor = new Compactor({ contentKeyDisposer: disposer });

    const insideHold = await withSessionAppendLock(KEPT_SESSION, () => compactor.tick());
    expect(insideHold).toEqual({ contentKeysReclaimed: 0, contentKeysSkipped: 0 });
    expect(disposer.sweeps).toBe(0);

    // The paired positive arm, on the same instance.
    await compactor.tick();
    expect(disposer.sweeps).toBe(1);
  });

  it("sweeps from a straggler that inherited the context but outlived the hold", async () => {
    // A released hold must not keep refusing: a task spawned inside the critical
    // section and run after release holds nothing.
    const disposer = new RecordingContentKeyDisposer();
    const compactor = new Compactor({ contentKeyDisposer: disposer });

    let straggler!: Promise<CompactionPassResult>;
    await withSessionAppendLock(KEPT_SESSION, () => {
      straggler = nextMacrotask().then(() => compactor.tick());
      return Promise.resolve();
    });

    await straggler;
    expect(disposer.sweeps).toBe(1);
  });
});
