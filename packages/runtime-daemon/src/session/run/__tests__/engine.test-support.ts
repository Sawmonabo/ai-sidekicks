// A run engine over a real scratch database, with runs queued through their `run.queued` event and
// the log read back by run.

import { randomUUID } from "node:crypto";

import { EventEnvelopeVersionSchema } from "@ai-sidekicks/contracts/event/envelope";
import type { ExecutionPosture } from "@ai-sidekicks/contracts/provider/driver/capabilities";
import { RunIdSchema, type RunId } from "@ai-sidekicks/contracts/run/id";
import { QueueItemIdSchema, type QueueItemSummary } from "@ai-sidekicks/contracts/run/queue";
import type { ChildRunProvenance } from "@ai-sidekicks/contracts/run/queued";
import { SessionIdSchema, type SessionId } from "@ai-sidekicks/contracts/session/id";

import {
  openScratchDatabase,
  type ScratchDatabase,
} from "../../../database/__fixtures__/scratch.js";
import { EventLogService } from "../../../events/log-service.js";
import { SessionEventAppender } from "../../../events/session/appender.js";
import type { ProviderDriver, StartRunParams } from "../../../provider/driver/contract.js";
import { RunEngine, type RunTransitionRequest } from "../engine.js";
import { insertQueuedRunStatement } from "../projection.js";
import { RunStateReader } from "../read.js";

/** How a child run hangs under its parent. */
interface ChildLink {
  readonly parentRunId: RunId;
  readonly reachedBy: ChildRunProvenance;
}

// A state whose change carries no required member.
type PathState = Exclude<RunTransitionRequest["newState"], "completed">;

/** One `run.*` row of a run, its payload parsed. */
interface RunEventRow {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

/** A driver whose `startRun` records each call it is handed. */
export interface RecordingDriver extends Pick<ProviderDriver, "startRun"> {
  readonly startedRuns: StartRunParams[];
}

/** The scratch database, an engine over it, and one session to queue runs in. */
export interface RunEngineFixture {
  readonly database: ScratchDatabase;
  readonly engine: RunEngine;
  /** The run reads every consumer of the engine takes beside it. */
  readonly runs: RunStateReader;
  readonly sessionEvents: EventLogService;
  readonly sessionId: SessionId;
  /** Appends `run.queued` with its row, as admission does, and returns the new run's id. */
  queueRun(child?: ChildLink): Promise<RunId>;
  /** Queues a run and moves it through each state in `path`, none of which needs a member. */
  runThrough(path: readonly PathState[], child?: ChildLink): Promise<RunId>;
  /** Every `run.*` event of `runId`, in log order. */
  readRunEvents(runId: RunId): RunEventRow[];
  /** A fresh engine over the same database, as the daemon builds one when it starts again. */
  restartEngine(): RunEngine;
  close(): Promise<void>;
}

/** A posture the driver is handed and `run.running` is stamped with. */
export const TEST_EXECUTION_POSTURE: ExecutionPosture = {
  mode: "sandboxed",
  writableRoots: ["/work/session-root"],
  credentialPolicyRef: "policy-default",
};

/** A driver that records every start and starts nothing. */
export function makeRecordingDriver(): RecordingDriver {
  const startedRuns: StartRunParams[] = [];
  return {
    startedRuns,
    startRun: (params) => {
      startedRuns.push(params);
      return Promise.resolve();
    },
  };
}

/** A queue item for a run's setup context. */
export function makeQueueItem(): QueueItemSummary {
  const now = new Date().toISOString();
  return {
    id: QueueItemIdSchema.parse(randomUUID()),
    state: "admitted",
    priority: 0,
    content: "Add the retry to the upload",
    createdAt: now,
    updatedAt: now,
  };
}

/** Opens a scratch database and a run engine over it. */
export async function openRunEngineFixture(): Promise<RunEngineFixture> {
  const database = await openScratchDatabase();
  const sessionEvents = new EventLogService({ writer: database.writer });
  const sessionId = SessionIdSchema.parse(randomUUID());
  const queuedAppender = new SessionEventAppender(
    { sessionEvents },
    EventEnvelopeVersionSchema.parse("1.0"),
  );
  const buildEngine = () => new RunEngine({ reader: database.reader, sessionEvents });
  const engine = buildEngine();

  async function queueRun(child?: ChildLink): Promise<RunId> {
    const runId = RunIdSchema.parse(randomUUID());
    const payload = {
      sessionId,
      runId,
      runVersion: 0,
      newState: "queued" as const,
      ...(child === undefined ? {} : child),
    };
    await queuedAppender.append("run.queued", payload, {
      transactionalPrelude: [insertQueuedRunStatement(payload)],
    });
    return runId;
  }

  return {
    database,
    engine,
    runs: new RunStateReader(database.reader),
    sessionEvents,
    sessionId,
    queueRun,
    runThrough: async (path, child) => {
      const runId = await queueRun(child);
      for (const newState of path) {
        await engine.transition({ runId, newState });
      }
      return runId;
    },
    readRunEvents: (runId) =>
      database.reader
        .prepare<[RunId], { type: string; payload: string }>(
          `SELECT type, payload FROM session_events
            WHERE category = 'run_lifecycle' AND json_extract(payload, '$.runId') = ?
            ORDER BY sequence`,
        )
        .all(runId)
        .map((row) => ({
          type: row.type,
          payload: JSON.parse(row.payload) as Record<string, unknown>,
        })),
    restartEngine: buildEngine,
    close: () => database.close(),
  };
}
