// The purge suite's fixture: a scratch database, a home folder for managed workspaces, the purge's
// real collaborators beside recording doubles for the receipt log and the live list, and raw seeds
// that put each row at an exact sequence.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeIdSchema, type NodeId } from "@ai-sidekicks/contracts/runtime-node/id";
import { SessionIdSchema, type SessionId } from "@ai-sidekicks/contracts/session/id";

import {
  openScratchDatabase,
  type ScratchDatabase,
} from "../../../database/__fixtures__/scratch.js";
import { KeyedLock } from "../../../keyed-lock.js";
import { EventLogService } from "../../log-service.js";
import { SessionRelatedRanking } from "../../../session/related/ranking.js";
import { WorkspaceEventEmitter } from "../../../workspace/event-emitter.js";
import { ManagedWorkspaceService } from "../../../workspace/managed/service.js";
import { RepoMountService } from "../../../workspace/repo/mount-service.js";
import {
  SessionPurge,
  type SessionPurgeDeps,
  type SessionPurgeEventLog,
  type SessionPurgeOutcome,
  type SessionPurgeResult,
} from "../purge.js";

/** The session each arm purges, and two it keeps. */
export const SESSION: SessionId = SessionIdSchema.parse("11111111-2222-4333-8444-555555555555");
export const SECOND_SESSION: SessionId = SessionIdSchema.parse(
  "11111111-2222-4333-8444-555555555556",
);
export const THIRD_SESSION: SessionId = SessionIdSchema.parse(
  "11111111-2222-4333-8444-555555555557",
);
/** The purge's clock, and every seeded row's time. */
export const PURGE_INSTANT = "2026-08-04T12:00:00.000Z";

const NODE: NodeId = NodeIdSchema.parse("node-purge-01");

/** The receipt payload members the arms read back. */
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

/** Records each receipt the purge appends. */
export class RecordingEventLog implements SessionPurgeEventLog {
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

/** Records each session the purge tells the live list of. */
export class RecordingSessionList {
  readonly refreshedSessionIds: SessionId[] = [];

  refresh(sessionIds: readonly SessionId[]): void {
    this.refreshedSessionIds.push(...sessionIds);
  }
}

interface SeedOptions {
  readonly category: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly sessionId?: SessionId;
  readonly sequence?: number | bigint;
  /** The machine-authored body, when this row carries one. */
  readonly contentPayload?: string;
}

// Each table a purge empties of the session's rows, and the query listing what it holds.
type DirectoryTable =
  | "sessions"
  | "drafts"
  | "groups"
  | "runs"
  | "consoleState"
  | "links"
  | "tags"
  | "related"
  | "mounts"
  | "workspaces"
  | "branchContexts"
  | "runExecutionContexts"
  | "queueItems"
  | "createRequests"
  | "convertRequests"
  | "convertFiles"
  | "interventions"
  | "runtimeBindings"
  | "commandReceipts"
  | "worktrees";

const DIRECTORY_ROW_QUERIES: Record<DirectoryTable, string> = {
  sessions: "SELECT id FROM sessions ORDER BY id",
  drafts: "SELECT session_id FROM session_drafts ORDER BY session_id",
  groups: "SELECT id FROM session_groups ORDER BY id",
  runs: "SELECT session_id FROM runs ORDER BY session_id",
  consoleState: "SELECT session_id FROM session_console_state ORDER BY session_id",
  links: "SELECT source_session_id, target_session_id FROM session_links ORDER BY 1, 2",
  tags: "SELECT session_id FROM session_tags ORDER BY session_id",
  related: "SELECT session_id, related_session_id FROM session_related ORDER BY 1, 2",
  mounts: "SELECT id FROM repo_mounts ORDER BY 1",
  workspaces: "SELECT id FROM workspaces ORDER BY 1",
  branchContexts: "SELECT id FROM branch_contexts ORDER BY 1",
  runExecutionContexts: "SELECT run_id FROM run_execution_contexts ORDER BY 1",
  queueItems: "SELECT session_id FROM queue_items ORDER BY 1",
  createRequests: "SELECT session_id FROM session_create_requests ORDER BY 1",
  convertRequests: "SELECT session_id FROM session_convert_requests ORDER BY 1",
  convertFiles: "SELECT session_id FROM session_convert_files ORDER BY 1",
  interventions: "SELECT target_run_id FROM interventions ORDER BY 1",
  runtimeBindings: "SELECT run_id FROM runtime_bindings ORDER BY 1",
  commandReceipts: "SELECT run_id FROM command_receipts ORDER BY 1",
  worktrees: "SELECT id FROM worktrees ORDER BY 1",
};

/**
 * The one session's outcome of a deletion that removes only it. A refusal of the whole deletion
 * has no outcome, so it fails the arm with its reason.
 */
export function onlyOutcome(result: SessionPurgeResult): SessionPurgeOutcome {
  const outcome = result.outcomes[0];
  if (outcome === undefined || result.outcomes.length !== 1) {
    throw new Error(
      `expected one session outcome; the deletion said: ${String(result.refusedReason)}`,
    );
  }
  return outcome;
}

/** One arm's database, home folder and purge collaborators; closed after the arm. */
export class PurgeFixture {
  readonly scratch: ScratchDatabase;
  readonly homeDirectory: string;
  readonly managedWorkspaces: ManagedWorkspaceService;
  readonly relatedRanking: SessionRelatedRanking;
  readonly sessionLock: KeyedLock<SessionId> = new KeyedLock<SessionId>();
  readonly sessionList: RecordingSessionList = new RecordingSessionList();
  #nextSequence = 0;

  private constructor(scratch: ScratchDatabase, homeDirectory: string) {
    this.scratch = scratch;
    this.homeDirectory = homeDirectory;
    this.managedWorkspaces = new ManagedWorkspaceService({
      homeDirectory,
      repoMounts: new RepoMountService({
        database: scratch,
        events: new WorkspaceEventEmitter({
          sessionEvents: new EventLogService({
            writer: scratch.writer,
            reader: scratch.reader,
            writeServiceLog: (line) => {
              throw new Error(`unexpected service log line: ${line}`);
            },
          }),
        }),
        nodeId: NODE,
      }),
    });
    this.relatedRanking = new SessionRelatedRanking({
      reader: scratch.reader,
      writer: scratch.writer,
      events: { followAll: () => () => {} },
      writeServiceLog: (line) => {
        throw new Error(`unexpected service log line: ${line}`);
      },
      now: () => new Date(PURGE_INSTANT),
    });
  }

  /** Opens a fresh database and home folder. */
  static async open(): Promise<PurgeFixture> {
    return new PurgeFixture(
      await openScratchDatabase(),
      mkdtempSync(join(tmpdir(), "ai-sidekicks-purge-home-")),
    );
  }

  /** Waits out the background re-scoring, then closes the database and removes the home folder. */
  async close(): Promise<void> {
    await this.relatedRanking.whenIdle();
    await this.scratch.close();
    rmSync(this.homeDirectory, { recursive: true, force: true });
  }

  /**
   * The purge over this fixture, appending its receipt to a recording log and writing through the
   * fixture's writer unless `overrides` names others.
   */
  buildPurge(
    overrides: Partial<
      Pick<
        SessionPurgeDeps,
        "eventLog" | "writer" | "checkpointRetryDelaysMs" | "whenFileCheckEnds"
      >
    > = {},
  ): SessionPurge {
    return new SessionPurge({
      writer: this.scratch.writer,
      nodeId: NODE,
      eventLog: new RecordingEventLog(),
      managedWorkspaces: this.managedWorkspaces,
      sessionLock: this.sessionLock,
      sessionList: this.sessionList,
      relatedRanking: this.relatedRanking,
      now: () => new Date(PURGE_INSTANT),
      whenFileCheckEnds: Promise.resolve(),
      ...overrides,
    });
  }

  async seed(
    options: SeedOptions,
  ): Promise<{ readonly id: string; readonly sequence: number | bigint }> {
    const sequence = options.sequence ?? this.#nextSequence++;
    const id = `evt-${(options.sessionId ?? SESSION).slice(-4)}-${String(sequence)}`;
    await this.scratch.writer.write([
      {
        sql: `INSERT INTO session_events
                (id, session_id, sequence, occurred_at, monotonic_ns, category, type, actor,
                 payload, correlation_id, causation_id, version, content_payload)
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

  seedMessage(
    text: string,
    sessionId: SessionId = SESSION,
  ): Promise<{ readonly id: string; readonly sequence: number | bigint }> {
    return this.seed({
      category: "session_lifecycle",
      type: "session.updated",
      payload: { text },
      sessionId,
      ...(sessionId === SESSION ? {} : { sequence: 0 }),
    });
  }

  async seedSnapshot(sessionId: SessionId, asOfSequence: number | bigint): Promise<string> {
    const id = `snap-${sessionId.slice(-4)}-${String(asOfSequence)}`;
    await this.scratch.writer.write([
      {
        sql: `INSERT INTO session_snapshots (id, session_id, as_of_sequence, state_blob, created_at)
              VALUES (?,?,?,?,?)`,
        bindings: [id, sessionId, asOfSequence, Buffer.from("{}"), "2026-08-01T00:00:00.000Z"],
      },
    ]);
    return id;
  }

  rowExists(table: "session_events" | "session_snapshots", id: string): boolean {
    return this.scratch.reader.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id) !== undefined;
  }

  // One project session's directory row, in the group named, when one is.
  async seedSessionRow(sessionId: SessionId, groupId: string | null = null): Promise<void> {
    await this.scratch.writer.write([
      {
        sql: `INSERT INTO sessions (id, shape, state, group_id, created_at, updated_at,
                                    last_activity_at)
              VALUES (?, 'project', 'archived', ?, ?, ?, ?)`,
        bindings: [sessionId, groupId, PURGE_INSTANT, PURGE_INSTANT, PURGE_INSTANT],
      },
    ]);
  }

  /** The rows each directory table holds, as one line per row, so an arm compares them whole. */
  readDirectoryRows(): Record<DirectoryTable, readonly string[]> {
    const rows = {} as Record<DirectoryTable, readonly string[]>;
    for (const [table, sql] of Object.entries(DIRECTORY_ROW_QUERIES) as [
      DirectoryTable,
      string,
    ][]) {
      rows[table] = (this.scratch.reader.prepare(sql).raw().all() as unknown[][]).map((row) =>
        row.join(" "),
      );
    }
    return rows;
  }

  // A workspace of the session on the mount, with a branch context and a run's execution root.
  async seedBoundRun(names: {
    readonly sessionId: SessionId;
    readonly repoMountId: string;
    readonly workspaceId: string;
    readonly runId: string;
  }): Promise<void> {
    const branchContextId = `branch-${names.workspaceId}`;
    await this.scratch.writer.write([
      {
        sql: `INSERT INTO workspaces (id, session_id, repo_mount_id, execution_mode, state,
                                      created_at, updated_at)
              VALUES (?, ?, ?, 'bound-root', 'ready', ?, ?)`,
        bindings: [
          names.workspaceId,
          names.sessionId,
          names.repoMountId,
          PURGE_INSTANT,
          PURGE_INSTANT,
        ],
      },
      {
        sql: `INSERT INTO branch_contexts (id, workspace_id, base_branch, head_branch, created_at,
                                           updated_at)
              VALUES (?, ?, 'main', 'main', ?, ?)`,
        bindings: [branchContextId, names.workspaceId, PURGE_INSTANT, PURGE_INSTANT],
      },
      {
        sql: `INSERT INTO run_execution_contexts (run_id, session_id, workspace_id, execution_mode,
                                                  execution_root, checkout_root, git_common_dir,
                                                  branch_context_id, created_at)
              VALUES (?, ?, ?, 'bound-root', '/root', '/root', '/root/.git', ?, ?)`,
        bindings: [names.runId, names.sessionId, names.workspaceId, branchContextId, PURGE_INSTANT],
      },
    ]);
  }

  // The rows that name the session or one of its runs: a queued message, the idempotency keys of
  // its create and its conversion, a file the conversion dealt with, and each run's steer, provider
  // binding and command receipt.
  async seedRowsNamingSession(sessionId: SessionId, runIds: readonly string[]): Promise<void> {
    await this.scratch.writer.write([
      {
        sql: `INSERT INTO queue_items (id, session_id, payload, created_at, updated_at)
              VALUES (?, ?, '{"text":"typed by the person"}', ?, ?)`,
        bindings: [`queue-${sessionId}`, sessionId, PURGE_INSTANT, PURGE_INSTANT],
      },
      {
        sql: `INSERT INTO session_create_requests
                (client_idempotency_key, session_id, execution_mode)
              VALUES (?, ?, 'bound-root')`,
        bindings: [`create-${sessionId}`, sessionId],
      },
      {
        sql: `INSERT INTO session_convert_requests
                (client_idempotency_key, session_id, repo_mount_id, working_tree)
              VALUES (?, ?, ?, ?)`,
        bindings: [
          `convert-${sessionId}`,
          sessionId,
          `project-mount-${sessionId}`,
          `/repos/${sessionId}`,
        ],
      },
      {
        sql: `INSERT INTO session_convert_files (session_id, path, outcome)
              VALUES (?, 'notes/plan.md', 'repository_has_file')`,
        bindings: [sessionId],
      },
      ...runIds.flatMap((runId) => [
        {
          sql: `INSERT INTO interventions (id, target_run_id, type, payload, expected_run_version,
                                           client_idempotency_key, created_at)
                VALUES (?, ?, 'steer', '{"text":"steer text"}', 1, ?, ?)`,
          bindings: [`steer-${runId}`, runId, `steer-key-${runId}`, PURGE_INSTANT],
        },
        {
          sql: `INSERT INTO runtime_bindings (id, run_id, driver_name, contract_version, created_at,
                                              updated_at)
                VALUES (?, ?, 'claude', '1.0', ?, ?)`,
          bindings: [`binding-${runId}`, runId, PURGE_INSTANT, PURGE_INSTANT],
        },
        {
          sql: `INSERT INTO command_receipts (id, command_id, run_id, status, created_at)
                VALUES (?, ?, ?, 'completed', ?)`,
          bindings: [`receipt-${runId}`, `command-${runId}`, runId, PURGE_INSTANT],
        },
      ]),
    ]);
  }
}
