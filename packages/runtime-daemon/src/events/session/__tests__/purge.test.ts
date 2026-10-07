// The whole-session purge deletes every purgeable row outright, with the session's draft, its
// directory rows and a chat's managed workspace, re-scores the related lists it leaves behind,
// refuses a session whose range the receipt could not name, leaves no copy of the content in the
// database file or its write-ahead log, and never runs inside an append-lock hold. Rows are seeded
// raw to sit at an exact sequence.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DAEMON_SCOPE_SENTINEL_SESSION_ID } from "@ai-sidekicks/contracts/event/envelope";
import { NodeIdSchema, type NodeId } from "@ai-sidekicks/contracts/runtime-node/id";
import { SessionIdSchema, type SessionId } from "@ai-sidekicks/contracts/session/id";

import {
  openScratchDatabase,
  type ScratchDatabase,
} from "../../../database/__fixtures__/scratch.js";
import { sessionAppendLock } from "../append-lock.js";
import { EventLogService } from "../../log-service.js";
import { recordedSessionLinkStatement } from "../../../session/links/recorded.js";
import { SessionRelatedRanking } from "../../../session/related/ranking.js";
import { WorkspaceEventEmitter } from "../../../workspace/event-emitter.js";
import { ManagedWorkspaceService } from "../../../workspace/managed/service.js";
import { RepoMountService } from "../../../workspace/repo/mount-service.js";
import {
  SessionPurge,
  type SessionPurgeEventLog,
  type SessionPurgeOutcome,
  type SessionPurgeResult,
} from "../purge.js";

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

let scratch: ScratchDatabase;
let nextSequence: number;
let homeDirectory: string;
let managedWorkspaces: ManagedWorkspaceService;
let relatedRanking: SessionRelatedRanking;

beforeEach(async () => {
  scratch = await openScratchDatabase();
  nextSequence = 0;
  homeDirectory = mkdtempSync(join(tmpdir(), "ai-sidekicks-purge-home-"));
  managedWorkspaces = new ManagedWorkspaceService({
    homeDirectory,
    repoMounts: new RepoMountService({
      database: scratch,
      events: new WorkspaceEventEmitter({
        sessionEvents: new EventLogService({ writer: scratch.writer, reader: scratch.reader }),
      }),
      nodeId: NODE,
    }),
  });
  relatedRanking = new SessionRelatedRanking({
    reader: scratch.reader,
    writer: scratch.writer,
    events: { followAll: () => () => {} },
    writeServiceLog: (line) => {
      throw new Error(`unexpected service log line: ${line}`);
    },
    now: () => new Date(PURGE_INSTANT),
  });
});

afterEach(async () => {
  await relatedRanking.whenIdle();
  await scratch.close();
  rmSync(homeDirectory, { recursive: true, force: true });
});

interface SeedOptions {
  readonly category: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly sessionId?: SessionId;
  readonly sequence?: number | bigint;
  /** The machine-authored body, when this row carries one. */
  readonly contentPayload?: string;
}

async function seed(
  options: SeedOptions,
): Promise<{ readonly id: string; readonly sequence: number | bigint }> {
  const sequence = options.sequence ?? nextSequence++;
  const id = `evt-${(options.sessionId ?? SESSION).slice(-4)}-${String(sequence)}`;
  await scratch.writer.write([
    {
      sql: `INSERT INTO session_events
              (id, session_id, sequence, occurred_at, monotonic_ns, category, type, actor, payload,
               correlation_id, causation_id, version, content_payload)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      bindings: [
        id,
        options.sessionId ?? SESSION,
        sequence,
        "2026-08-01T00:00:00.000Z",
        BigInt(sequence) + 1n,
        options.category,
        options.type,
        null,
        JSON.stringify(options.payload),
        "corr-1",
        "caus-1",
        "1.0",
        options.contentPayload ?? null,
      ],
    },
  ]);
  return { id, sequence };
}

function seedMessage(
  text: string,
  sessionId: SessionId = SESSION,
): Promise<{ readonly id: string; readonly sequence: number | bigint }> {
  return seed({
    category: "session_lifecycle",
    type: "session.updated",
    payload: { text },
    sessionId,
    ...(sessionId === SESSION ? {} : { sequence: 0 }),
  });
}

async function seedSnapshot(sessionId: SessionId, asOfSequence: number | bigint): Promise<string> {
  const id = `snap-${sessionId.slice(-4)}-${String(asOfSequence)}`;
  await scratch.writer.write([
    {
      sql: `INSERT INTO session_snapshots (id, session_id, as_of_sequence, state_blob, created_at)
            VALUES (?,?,?,?,?)`,
      bindings: [id, sessionId, asOfSequence, Buffer.from("{}"), "2026-08-01T00:00:00.000Z"],
    },
  ]);
  return id;
}

function rowExists(table: "session_events" | "session_snapshots", id: string): boolean {
  return scratch.reader.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id) !== undefined;
}

function buildPurge(eventLog: SessionPurgeEventLog = new RecordingEventLog()): SessionPurge {
  return new SessionPurge({
    writer: scratch.writer,
    nodeId: NODE,
    eventLog,
    managedWorkspaces,
    relatedRanking,
    now: () => new Date(PURGE_INSTANT),
  });
}

// One project session's directory row, in the group named, when one is.
async function seedSessionRow(sessionId: SessionId, groupId: string | null = null): Promise<void> {
  await scratch.writer.write([
    {
      sql: `INSERT INTO sessions (id, shape, state, group_id, created_at, updated_at,
                                  last_activity_at)
            VALUES (?, 'project', 'archived', ?, ?, ?, ?)`,
      bindings: [sessionId, groupId, PURGE_INSTANT, PURGE_INSTANT, PURGE_INSTANT],
    },
  ]);
}

// The rows each directory table holds, as one line per row, so an arm compares them whole.
function readDirectoryRows() {
  const read = (sql: string): readonly string[] =>
    (scratch.reader.prepare(sql).raw().all() as unknown[][]).map((row) => row.join(" "));
  return {
    sessions: read("SELECT id FROM sessions ORDER BY id"),
    drafts: read("SELECT session_id FROM session_drafts ORDER BY session_id"),
    groups: read("SELECT id FROM session_groups ORDER BY id"),
    runActivity: read("SELECT session_id FROM session_run_activity ORDER BY session_id"),
    consoleState: read("SELECT session_id FROM session_console_state ORDER BY session_id"),
    links: read("SELECT source_session_id, target_session_id FROM session_links ORDER BY 1, 2"),
    tags: read("SELECT session_id FROM session_tags ORDER BY session_id"),
    related: read("SELECT session_id, related_session_id FROM session_related ORDER BY 1, 2"),
    mounts: read("SELECT managed_session_id FROM repo_mounts ORDER BY 1"),
  };
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
    const first = await seedMessage("hi");
    const maintenance = await seed({
      category: "event_maintenance",
      type: "event.compacted",
      payload: { ok: true },
    });
    const newest = await seedMessage("yo");
    const snapshot = await seedSnapshot(SESSION, newest.sequence);
    const otherSession = await seedMessage("kept", SECOND_SESSION);
    const otherSnapshot = await seedSnapshot(SECOND_SESSION, otherSession.sequence);

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

describe("SessionPurge — the session's directory rows and managed workspace", () => {
  it("deletes every row naming the session, the group it empties and its workspace", async () => {
    await scratch.writer.write([
      {
        sql: `INSERT INTO session_groups (id, project_id, name, name_folded, created_at)
              VALUES ('group-emptied', 'project-1', 'Emptied', 'emptied', ?),
                     ('group-kept', 'project-1', 'Kept', 'kept', ?)`,
        bindings: [PURGE_INSTANT, PURGE_INSTANT],
      },
    ]);
    await seedSessionRow(SESSION, "group-emptied");
    await seedSessionRow(SECOND_SESSION, "group-kept");
    await seedSessionRow(THIRD_SESSION, "group-kept");
    await seedMessage("hi");
    const purgedWorkspace = await managedWorkspaces.create({ sessionId: SESSION });
    const keptWorkspace = await managedWorkspaces.create({ sessionId: SECOND_SESSION });
    for (const sessionId of [SESSION, SECOND_SESSION]) {
      await scratch.writer.write([
        {
          sql: "INSERT INTO session_run_activity (session_id, run_id, activity) VALUES (?, ?, ?)",
          bindings: [sessionId, `run-${sessionId}`, "running"],
        },
        {
          sql: "INSERT INTO session_console_state (session_id, updated_at) VALUES (?, ?)",
          bindings: [sessionId, PURGE_INSTANT],
        },
        {
          sql: "INSERT INTO session_tags (session_id, tag, tag_folded) VALUES (?, 'Billing', 'billing')",
          bindings: [sessionId],
        },
        {
          sql: "INSERT INTO session_drafts (session_id, text, updated_at) VALUES (?, 'unsent', ?)",
          bindings: [sessionId, PURGE_INSTANT],
        },
      ]);
    }
    for (const [source, target] of [
      [SESSION, SECOND_SESSION],
      [SECOND_SESSION, SESSION],
      [SECOND_SESSION, THIRD_SESSION],
    ]) {
      await scratch.writer.write([
        {
          sql: `INSERT INTO session_links (source_session_id, target_session_id, kind, first_at,
                                           last_at)
                VALUES (?, ?, 'related', ?, ?)`,
          bindings: [source, target, PURGE_INSTANT, PURGE_INSTANT],
        },
        {
          sql: `INSERT INTO session_related (session_id, related_session_id, score)
                VALUES (?, ?, 0.5)`,
          bindings: [source, target],
        },
      ]);
    }

    const result = await buildPurge().purge([SESSION]);

    expect(result.refusedReason).toBeUndefined();
    expect(onlyOutcome(result).refusedReason).toBeUndefined();
    expect(readDirectoryRows()).toEqual({
      sessions: [SECOND_SESSION, THIRD_SESSION],
      drafts: [SECOND_SESSION],
      groups: ["group-kept"],
      runActivity: [SECOND_SESSION],
      consoleState: [SECOND_SESSION],
      links: [`${SECOND_SESSION} ${THIRD_SESSION}`],
      tags: [SECOND_SESSION],
      related: [`${SECOND_SESSION} ${THIRD_SESSION}`],
      mounts: [SECOND_SESSION],
    });
    expect(existsSync(purgedWorkspace.path)).toBe(false);
    expect(existsSync(keptWorkspace.path)).toBe(true);
  });

  it("re-scores a linked session's list, so no score keeps a share of the purged one", async () => {
    for (const sessionId of [SESSION, SECOND_SESSION, THIRD_SESSION]) {
      await seedSessionRow(sessionId);
    }
    await seedMessage("hi");
    for (const [sourceSessionId, targetSessionId] of [
      [SESSION, SECOND_SESSION],
      [SECOND_SESSION, THIRD_SESSION],
    ] as const) {
      await scratch.writer.write([
        recordedSessionLinkStatement({
          sourceSessionId,
          targetSessionId,
          kind: "started",
          occurredAt: PURGE_INSTANT,
        }),
      ]);
    }
    relatedRanking.rescoreAround([SESSION, SECOND_SESSION, THIRD_SESSION]);
    await relatedRanking.whenIdle();
    const secondSessionScores = (): readonly string[] =>
      (
        scratch.reader
          .prepare("SELECT related_session_id, score FROM session_related WHERE session_id = ?")
          .raw()
          .all(SECOND_SESSION) as unknown[][]
      ).map((row) => row.join(" "));
    // Half of the second session's walk goes to each of its two linked sessions.
    expect([...secondSessionScores()].sort()).toEqual(
      [`${SESSION} 0.5`, `${THIRD_SESSION} 0.5`].sort(),
    );

    const result = await buildPurge().purge([SESSION]);
    await relatedRanking.whenIdle();

    expect(result.refusedReason).toBeUndefined();
    expect(secondSessionScores()).toEqual([`${THIRD_SESSION} 1`]);
  });

  it("keeps the managed workspace of a session whose rows were refused", async () => {
    await seed({
      category: "session_lifecycle",
      type: "session.updated",
      payload: { text: "far" },
      sequence: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
    });
    const workspace = await managedWorkspaces.create({ sessionId: SESSION });

    const outcome = onlyOutcome(await buildPurge().purge([SESSION]));

    expect(outcome.refusedReason).toContain("not safe integers");
    expect(existsSync(join(workspace.path, ".git"))).toBe(true);
    expect(readDirectoryRows().mounts).toEqual([SESSION]);
  });
});

describe("SessionPurge — one receipt per deletion", () => {
  it("rolls a refused session back whole and carries on with the next", async () => {
    await seedMessage("a");
    const refusedRow = await seedMessage("b", SECOND_SESSION);
    const refusedSnapshot = await seedSnapshot(SECOND_SESSION, refusedRow.sequence);
    await seedMessage("c", THIRD_SESSION);
    // The second session's event delete fails after its snapshot delete ran.
    await scratch.writer.write([
      {
        sql: `CREATE TRIGGER refuse_second BEFORE DELETE ON session_events
                WHEN OLD.session_id = '${SECOND_SESSION}'
                BEGIN SELECT RAISE(ABORT, 'refused for the test'); END`,
      },
    ]);
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

describe("SessionPurge — a range the receipt could not name", () => {
  it("refuses the session and deletes none of its rows", async () => {
    // Past the safe integers, the read-back number would name a different row than the stored one.
    const unsafe = await seed({
      category: "session_lifecycle",
      type: "session.updated",
      payload: { text: "far" },
      sequence: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
    });
    const eventLog = new RecordingEventLog();

    const outcome = onlyOutcome(await buildPurge(eventLog).purge([SESSION]));

    expect(outcome.rowsDeleted).toBe(0);
    expect(outcome.refusedReason).toContain("not safe integers");
    expect(rowExists("session_events", unsafe.id)).toBe(true);
    expect(eventLog.appended).toEqual([]);
  });
});

describe("SessionPurge — no copy survives on disk", () => {
  it("leaves the content in neither the database file nor its write-ahead log", async () => {
    const marker = "purge-marker-7f3a9c";
    await seed({
      category: "assistant_output",
      type: "assistant.message",
      payload: { text: marker },
      contentPayload: `${marker} `.repeat(40),
    });
    // Move the row into the database file, so the delete has to clear it there too.
    await scratch.writer.checkpoint("TRUNCATE");

    const result = await buildPurge().purge([SESSION]);

    expect(result.refusedReason).toBeUndefined();
    expect(onlyOutcome(result).rowsDeleted).toBe(1);
    // Read while the connections are open: closing the writer would checkpoint the log on its own.
    const walPath = `${scratch.databasePath}-wal`;
    const onDisk = [scratch.databasePath, ...(existsSync(walPath) ? [walPath] : [])];
    for (const filePath of onDisk) {
      expect(readFileSync(filePath).includes(marker), filePath).toBe(false);
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
    const candidate = await seedMessage("destroyable");
    const purge = buildPurge();

    for (const heldSession of [SESSION, SECOND_SESSION]) {
      const insideHold = await sessionAppendLock.run(heldSession, () => purge.purge([SESSION]));
      expect(insideHold.outcomes).toEqual([]);
      expect(insideHold.refusedReason).toContain("append-lock hold");
      expect(rowExists("session_events", candidate.id)).toBe(true);
    }

    const outsideHold = await purge.purge([SESSION]).then(onlyOutcome);
    expect(outsideHold.refusedReason).toBeUndefined();
    expect(rowExists("session_events", candidate.id)).toBe(false);
  });
});
