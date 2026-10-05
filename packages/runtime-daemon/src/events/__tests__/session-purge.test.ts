// The whole-session purge deletes every purgeable row outright, leaves no copy of the content in
// the database file or its write-ahead log, and never runs inside an append-lock hold. Rows are
// seeded raw to sit at an exact sequence.

import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Database as DatabaseType } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DAEMON_SCOPE_SENTINEL_SESSION_ID } from "@ai-sidekicks/contracts/event/envelope";
import { NodeIdSchema, type NodeId } from "@ai-sidekicks/contracts/node-id";
import { SessionIdSchema, type SessionId } from "@ai-sidekicks/contracts/session/session";

import { openDatabase } from "../../session/migration-runner.js";
import { withSessionAppendLock } from "../session-append-lock.js";
import {
  SessionPurge,
  type SessionPurgeEventLog,
  type SessionPurgeOutcome,
  type SessionPurgeResult,
} from "../session-purge.js";

const SESSION: SessionId = SessionIdSchema.parse("11111111-2222-4333-8444-555555555555");
const SECOND_SESSION: SessionId = SessionIdSchema.parse("11111111-2222-4333-8444-555555555556");
const THIRD_SESSION: SessionId = SessionIdSchema.parse("11111111-2222-4333-8444-555555555557");
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

let database: DatabaseType;
let nextSequence: number;

beforeEach(() => {
  database = openDatabase(":memory:");
  nextSequence = 0;
});

afterEach(() => {
  database.close();
});

interface SeedOptions {
  readonly category: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly sessionId?: SessionId;
  readonly sequence?: number;
  /** The machine-authored body, when this row carries one. */
  readonly contentPayload?: string;
}

function seed(options: SeedOptions): { readonly id: string; readonly sequence: number } {
  const sequence = options.sequence ?? nextSequence++;
  const id = `evt-${(options.sessionId ?? SESSION).slice(-4)}-${String(sequence)}`;
  database
    .prepare(
      `INSERT INTO session_events
         (id, session_id, sequence, occurred_at, monotonic_ns, category, type, actor, payload,
          correlation_id, causation_id, version, content_payload)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
      JSON.stringify(options.payload),
      "corr-1",
      "caus-1",
      "1.0",
      options.contentPayload ?? null,
    );
  return { id, sequence };
}

function seedMessage(
  text: string,
  sessionId: SessionId = SESSION,
): { readonly id: string; readonly sequence: number } {
  return seed({
    category: "session_lifecycle",
    type: "session.updated",
    payload: { text },
    sessionId,
    ...(sessionId === SESSION ? {} : { sequence: 0 }),
  });
}

function seedSnapshot(sessionId: SessionId, asOfSequence: number): string {
  const id = `snap-${sessionId.slice(-4)}-${String(asOfSequence)}`;
  database
    .prepare(
      `INSERT INTO session_snapshots (id, session_id, as_of_sequence, state_blob, created_at)
       VALUES (?,?,?,?,?)`,
    )
    .run(id, sessionId, asOfSequence, Buffer.from("{}"), "2026-08-01T00:00:00.000Z");
  return id;
}

function rowExists(table: "session_events" | "session_snapshots", id: string): boolean {
  return database.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id) !== undefined;
}

function buildPurge(eventLog: SessionPurgeEventLog = new RecordingEventLog()): SessionPurge {
  return new SessionPurge({
    db: database,
    nodeId: NODE,
    eventLog,
    now: () => new Date(PURGE_INSTANT),
  });
}

/**
 * The one session's outcome of a deletion that removes only it. A refusal of the whole deletion
 * has no outcome, so it fails the arm with its reason.
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
  it("deletes every purgeable row and snapshot, sparing maintenance rows and others", async () => {
    const first = seedMessage("hi");
    const maintenance = seed({
      category: "event_maintenance",
      type: "event.compacted",
      payload: { ok: true },
    });
    const newest = seedMessage("yo");
    const snapshot = seedSnapshot(SESSION, newest.sequence);
    const otherSession = seedMessage("kept", SECOND_SESSION);
    const otherSnapshot = seedSnapshot(SECOND_SESSION, otherSession.sequence);

    const eventLog = new RecordingEventLog();
    const result = await buildPurge(eventLog).purge([SESSION]);
    const outcome = onlyOutcome(result);

    expect(result.refusedReason).toBeUndefined();
    expect(outcome.refusedReason).toBeUndefined();
    expect(outcome.rowsDeleted).toBe(2);
    expect(outcome.fromSequence).toBe(first.sequence);
    expect(outcome.toSequence).toBe(newest.sequence);

    expect(rowExists("session_events", first.id)).toBe(false);
    expect(rowExists("session_events", newest.id)).toBe(false);
    expect(rowExists("session_snapshots", snapshot)).toBe(false);
    expect(rowExists("session_events", maintenance.id)).toBe(true);
    expect(rowExists("session_events", otherSession.id)).toBe(true);
    expect(rowExists("session_snapshots", otherSnapshot)).toBe(true);

    // One receipt, bound to the sentinel, naming the deleted range.
    expect(eventLog.appended).toHaveLength(1);
    expect(eventLog.appended[0]?.sessionId).toBe(DAEMON_SCOPE_SENTINEL_SESSION_ID);
    expect(eventLog.appended[0]?.category).toBe("event_maintenance");
    expect(eventLog.appended[0]?.type).toBe("event.compacted");
    expect(eventLog.appended[0]?.payload.removedSessions).toEqual([
      { sessionId: SESSION, fromSeq: first.sequence, toSeq: newest.sequence },
    ]);
  });
});

describe("SessionPurge — one receipt per deletion", () => {
  it("rolls a refused session back whole and carries on with the next", async () => {
    seedMessage("a");
    const refusedRow = seedMessage("b", SECOND_SESSION);
    const refusedSnapshot = seedSnapshot(SECOND_SESSION, refusedRow.sequence);
    seedMessage("c", THIRD_SESSION);
    // The second session's event delete fails after its snapshot delete ran.
    database.exec(`CREATE TRIGGER refuse_second BEFORE DELETE ON session_events
      WHEN OLD.session_id = '${SECOND_SESSION}'
      BEGIN SELECT RAISE(ABORT, 'refused for the test'); END;`);
    const eventLog = new RecordingEventLog();

    const result = await buildPurge(eventLog).purge([SESSION, SECOND_SESSION, THIRD_SESSION]);

    expect(result.refusedReason).toBeUndefined();
    const [first, second, third] = result.outcomes;
    expect(first?.rowsDeleted).toBe(1);
    expect(second?.rowsDeleted).toBe(0);
    expect(second?.refusedReason).toContain("refused for the test");
    expect(third?.rowsDeleted).toBe(1);
    expect(rowExists("session_events", refusedRow.id)).toBe(true);
    expect(rowExists("session_snapshots", refusedSnapshot)).toBe(true);
    expect(eventLog.appended).toHaveLength(1);
    expect(eventLog.appended[0]?.payload.removedSessions).toEqual([
      { sessionId: SESSION, fromSeq: 0, toSeq: 0 },
      { sessionId: THIRD_SESSION, fromSeq: 0, toSeq: 0 },
    ]);
  });
});

describe("SessionPurge — no copy survives on disk", () => {
  it("leaves the content in neither the database file nor its write-ahead log", async () => {
    const directory = mkdtempSync(join(tmpdir(), "session-purge-"));
    const databasePath = join(directory, "daemon.db");
    database.close();
    database = openDatabase(databasePath);
    const marker = "purge-marker-7f3a9c";
    try {
      seed({
        category: "assistant_output",
        type: "assistant.message",
        payload: { text: marker },
        contentPayload: `${marker} `.repeat(40),
      });
      // Move the row into the database file, so the delete has to clear it there too.
      database.pragma("wal_checkpoint(TRUNCATE)");

      const result = await buildPurge().purge([SESSION]);

      expect(result.refusedReason).toBeUndefined();
      expect(onlyOutcome(result).rowsDeleted).toBe(1);
      // Read while the connection is open: closing it would checkpoint the log on its own.
      const walPath = `${databasePath}-wal`;
      const onDisk = [databasePath, ...(existsSync(walPath) ? [walPath] : [])];
      for (const filePath of onDisk) {
        expect(readFileSync(filePath).includes(marker), filePath).toBe(false);
      }
    } finally {
      database.close();
      database = openDatabase(":memory:");
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

// The arm below pins a purge that declined to run, so it is paired with a positive arm over the
// same seeds: without the pairing, "nothing was deleted" passes just as well against a purge that
// never deletes anything.

describe("SessionPurge — a purge entered inside an append-lock hold is refused", () => {
  it("refuses under a hold on any session, and purges outside it", async () => {
    // The lock is reentrant per owner, so a purge inside a hold on the session would acquire
    // nothing for its rows.
    const candidate = seedMessage("destroyable");
    const purge = buildPurge();

    for (const heldSession of [SESSION, SECOND_SESSION]) {
      const insideHold = await withSessionAppendLock(heldSession, () => purge.purge([SESSION]));
      expect(insideHold.outcomes).toEqual([]);
      expect(insideHold.refusedReason).toContain("append-lock hold");
      expect(rowExists("session_events", candidate.id)).toBe(true);
    }

    const outsideHold = await purge.purge([SESSION]).then(onlyOutcome);
    expect(outsideHold.refusedReason).toBeUndefined();
    expect(rowExists("session_events", candidate.id)).toBe(false);
  });
});
