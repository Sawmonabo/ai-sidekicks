// The engine's side of a restart over a real database: each run the restart left live settles
// failed or interrupted with one terminal, and nothing is started again.

import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RunId } from "@ai-sidekicks/contracts/run/id";

import {
  TEST_EXECUTION_POSTURE,
  makeQueueItem,
  makeRecordingDriver,
  openRunEngineFixture,
  type RecordingDriver,
  type RunEngineFixture,
} from "./engine.test-support.js";

describe("run settle after a restart", () => {
  let fixture: RunEngineFixture;
  let driver: RecordingDriver;

  beforeEach(async () => {
    fixture = await openRunEngineFixture();
    driver = makeRecordingDriver();
  });

  afterEach(async () => {
    await fixture.close();
  });

  async function startRun(runId: RunId): Promise<void> {
    await fixture.engine.startRun({
      runId,
      queueItem: makeQueueItem(),
      provider: "claude",
      driver,
      driverParams: { agentConfig: {} },
      executionPosture: TEST_EXECUTION_POSTURE,
    });
  }

  async function requestInterrupt(runId: RunId): Promise<void> {
    await fixture.database.writer.write([
      {
        sql: `INSERT INTO interventions
                (id, target_run_id, type, state, expected_run_version, client_idempotency_key,
                 created_at)
              VALUES (?, ?, 'interrupt', 'accepted', 2, ?, ?)`,
        bindings: [randomUUID(), runId, randomUUID(), new Date().toISOString()],
      },
    ]);
  }

  it("settles a crashed run failed, a stopped one interrupted and a held child interrupted, starting none again", async () => {
    const crashed = await fixture.queueRun();
    await startRun(crashed);
    const stopped = await fixture.queueRun();
    await startRun(stopped);
    await requestInterrupt(stopped);
    const heldChild = await fixture.runThrough(["starting", "running", "pausing", "paused"], {
      parentRunId: crashed,
      reachedBy: "provider_subagent",
    });
    const queued = await fixture.queueRun();
    const runCountBefore = fixture.database.reader
      .prepare("SELECT COUNT(*) AS runs FROM runs")
      .get();

    const restarted = fixture.restartEngine();
    for (const live of fixture.runs.listLiveRuns()) {
      await restarted.settleRunAfterRestart(live, "The conversation file was not found");
    }

    expect(fixture.readRunEvents(crashed).filter((row) => row.type === "run.failed")).toEqual([
      {
        type: "run.failed",
        payload: {
          sessionId: fixture.sessionId,
          runId: crashed,
          runVersion: 3,
          previousState: "running",
          newState: "failed",
          failureCategory: "provider failure",
          recoveryCondition: "recovery-needed",
          providerFailureDetail: "The conversation file was not found",
        },
      },
    ]);
    for (const runId of [stopped, heldChild]) {
      const events = fixture.readRunEvents(runId);
      expect(events.filter((row) => row.type === "run.interrupted")).toHaveLength(1);
      expect(events.some((row) => row.type === "run.failed")).toBe(false);
    }
    expect(fixture.runs.getRun(queued)?.state).toBe("queued");
    // Nothing was started again: no driver call since the crash, no run added, no second start.
    expect(driver.startedRuns.map((params) => params.runId)).toEqual([crashed, stopped]);
    expect(fixture.database.reader.prepare("SELECT COUNT(*) AS runs FROM runs").get()).toEqual(
      runCountBefore,
    );
    for (const runId of [crashed, stopped]) {
      expect(
        fixture.readRunEvents(runId).filter((row) => row.type === "run.starting"),
      ).toHaveLength(1);
    }

    // The held child continues from its own box on its own id.
    await restarted.transition({ runId: heldChild, newState: "running" });
    expect(fixture.runs.getRun(heldChild)).toMatchObject({ state: "running", version: 6 });
  });

  it("refuses a failed settle when the person's interrupt lands after it was decided", async () => {
    const runId = await fixture.queueRun();
    await startRun(runId);
    const restarted = fixture.restartEngine();
    const [live] = fixture.runs.listLiveRuns();
    if (live === undefined) {
      throw new Error("The started run reads as not live");
    }

    // The settle reads no interrupt and decides failed; the interrupt's write is queued first.
    const settle = restarted.settleRunAfterRestart(live, "The conversation file was not found");
    const interrupt = requestInterrupt(runId);

    await expect(settle).rejects.toMatchObject({ statementIndex: 2, rowCount: 1 });
    await interrupt;
    expect(fixture.readRunEvents(runId).some((row) => row.type === "run.failed")).toBe(false);
    const [stillLive] = fixture.runs.listLiveRuns();
    if (stillLive === undefined) {
      throw new Error("The refused settle ended the run");
    }
    await restarted.settleRunAfterRestart(stillLive, "The conversation file was not found");
    expect(fixture.runs.getRun(runId)?.state).toBe("interrupted");
  });
});
