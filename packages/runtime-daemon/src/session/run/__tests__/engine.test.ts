// The run engine over a real database: the setup gates around a run's start, the terminal hooks,
// a provider process that ends on its own, and a run that waits and comes back on its own id.

import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProcessExit } from "@ai-sidekicks/contracts/run/control";
import type { RunId } from "@ai-sidekicks/contracts/run/id";

import { RunAlreadyEndedError } from "../refusals.js";
import {
  RunParkedInSetupError,
  type RunSetupGate,
  type RunTerminalContext,
} from "../setup-gates.js";
import {
  TEST_EXECUTION_POSTURE,
  makeQueueItem,
  makeRecordingDriver,
  openRunEngineFixture,
  type RunEngineFixture,
} from "./engine.test-support.js";

describe("run engine", () => {
  let fixture: RunEngineFixture;

  beforeEach(async () => {
    fixture = await openRunEngineFixture();
  });

  afterEach(async () => {
    await fixture.close();
  });

  // A gate that records its checks and terminal hooks under `name` into one shared log.
  function recordingGate(
    name: string,
    log: string[],
    terminals: RunTerminalContext[] = [],
  ): RunSetupGate {
    return {
      assertRunReady: () => {
        log.push(`${name} ready`);
        return Promise.resolve();
      },
      onRunTerminal: (context) => {
        log.push(`${name} terminal`);
        terminals.push(context);
        return Promise.resolve();
      },
    };
  }

  async function startRun(runId: RunId): Promise<void> {
    await fixture.engine.startRun({
      runId,
      queueItem: makeQueueItem(),
      driver: makeRecordingDriver(),
      driverParams: { agentConfig: {} },
      executionPosture: TEST_EXECUTION_POSTURE,
    });
  }

  describe("setup gates", () => {
    it("starts a run with no gate, then runs gates in order before the driver and stamps its posture", async () => {
      const ungated = await fixture.queueRun();
      await startRun(ungated);
      expect(fixture.runs.getRun(ungated)?.state).toBe("running");

      const log: string[] = [];
      fixture.engine.registerSetupGate(recordingGate("first", log));
      fixture.engine.registerSetupGate(recordingGate("second", log));
      const driver = makeRecordingDriver();
      const originalStart = driver.startRun;
      const gated = await fixture.queueRun();
      await fixture.engine.startRun({
        runId: gated,
        queueItem: makeQueueItem(),
        driver: {
          startRun: async (params) => {
            log.push("driver");
            await originalStart(params);
          },
        },
        driverParams: { agentConfig: {} },
        executionPosture: TEST_EXECUTION_POSTURE,
      });

      expect(log).toEqual(["first ready", "second ready", "driver"]);
      const running = fixture.readRunEvents(gated).at(-1);
      expect(running?.type).toBe("run.running");
      expect(running?.payload["executionPosture"]).toEqual(driver.startedRuns[0]?.executionPosture);
      expect(driver.startedRuns[0]?.executionPosture).toBe(TEST_EXECUTION_POSTURE);
    });

    it("parks a run in starting on a gate's throw, and an interrupt then ends it", async () => {
      const gateError = new Error("The session's workspace is not ready");
      const log: string[] = [];
      fixture.engine.registerSetupGate({
        assertRunReady: () => Promise.reject(gateError),
      });
      fixture.engine.registerSetupGate(recordingGate("after", log));
      const driver = makeRecordingDriver();
      const runId = await fixture.queueRun();

      const refusal: unknown = await fixture.engine
        .startRun({
          runId,
          queueItem: makeQueueItem(),
          driver,
          driverParams: { agentConfig: {} },
          executionPosture: TEST_EXECUTION_POSTURE,
        })
        .catch((error: unknown) => error);

      expect(refusal).toBeInstanceOf(RunParkedInSetupError);
      expect((refusal as RunParkedInSetupError).cause).toBe(gateError);
      expect(fixture.runs.getRun(runId)?.state).toBe("starting");
      expect(driver.startedRuns).toEqual([]);
      expect(log).toEqual([]);

      await fixture.engine.settleInterventionOutcome({
        runId,
        interventionType: "interrupt",
        state: "applied",
      });
      expect(fixture.runs.getRun(runId)?.state).toBe("interrupted");
      expect(log).toEqual(["after terminal"]);
    });

    it("does not hand the driver a run interrupted while a gate checked it", async () => {
      const runId = await fixture.queueRun();
      fixture.engine.registerSetupGate({
        assertRunReady: () =>
          fixture.engine.settleInterventionOutcome({
            runId,
            interventionType: "interrupt",
            state: "applied",
          }),
      });
      const driver = makeRecordingDriver();

      await expect(
        fixture.engine.startRun({
          runId,
          queueItem: makeQueueItem(),
          driver,
          driverParams: { agentConfig: {} },
          executionPosture: TEST_EXECUTION_POSTURE,
        }),
      ).rejects.toMatchObject({ code: "run.invalid_transition", fromState: "interrupted" });
      expect(driver.startedRuns).toEqual([]);
      expect(fixture.runs.getRun(runId)?.state).toBe("interrupted");
    });

    it("ends a run failed with the driver's words when the driver cannot start it", async () => {
      const runId = await fixture.queueRun();
      const driverError = new Error("spawn claude ENOENT");

      const thrown: unknown = await fixture.engine
        .startRun({
          runId,
          queueItem: makeQueueItem(),
          driver: { startRun: () => Promise.reject(driverError) },
          driverParams: { agentConfig: {} },
          executionPosture: TEST_EXECUTION_POSTURE,
        })
        .catch((error: unknown) => error);

      expect(thrown).toBe(driverError);
      expect(fixture.readRunEvents(runId).at(-1)).toEqual({
        type: "run.failed",
        payload: {
          sessionId: fixture.sessionId,
          runId,
          runVersion: 2,
          previousState: "starting",
          newState: "failed",
          failureCategory: "provider failure",
          providerFailureDetail: "spawn claude ENOENT",
        },
      });
    });

    it("runs terminal hooks in reverse order once per run version, again after a send re-opens the run", async () => {
      const log: string[] = [];
      const terminals: RunTerminalContext[] = [];
      fixture.engine.registerSetupGate(recordingGate("first", log, terminals));
      fixture.engine.registerSetupGate(recordingGate("second", log, terminals));
      const runId = await fixture.queueRun();
      await startRun(runId);
      log.length = 0;

      await fixture.engine.settleInterventionOutcome({
        runId,
        interventionType: "interrupt",
        state: "degraded",
      });
      // A second interrupt of the same run version is refused and releases nothing again.
      await expect(
        fixture.engine.settleInterventionOutcome({
          runId,
          interventionType: "interrupt",
          state: "applied",
        }),
      ).rejects.toBeInstanceOf(RunAlreadyEndedError);
      await fixture.engine.transition({ runId, newState: "running" });
      await fixture.engine.transition({ runId, newState: "completed", completionKind: "turn" });

      expect(log).toEqual([
        "second terminal",
        "first terminal",
        "second terminal",
        "first terminal",
      ]);
      expect(
        terminals.map(({ terminalState, runVersion }) => ({ terminalState, runVersion })),
      ).toEqual([
        { terminalState: "interrupted", runVersion: 3 },
        { terminalState: "interrupted", runVersion: 3 },
        { terminalState: "completed", runVersion: 5 },
        { terminalState: "completed", runVersion: 5 },
      ]);
    });

    it("runs every terminal hook when one throws, then throws its error with the run ended", async () => {
      const log: string[] = [];
      const hookError = new Error("The approval could not be canceled");
      fixture.engine.registerSetupGate(recordingGate("first", log));
      fixture.engine.registerSetupGate({
        assertRunReady: () => Promise.resolve(),
        onRunTerminal: () => Promise.reject(hookError),
      });
      const runId = await fixture.runThrough(["starting", "running"]);

      const thrown: unknown = await fixture.engine
        .transition({ runId, newState: "interrupted" })
        .catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(AggregateError);
      expect((thrown as AggregateError).errors).toEqual([hookError]);
      expect(log).toEqual(["first terminal"]);
      expect(fixture.runs.getRun(runId)?.state).toBe("interrupted");
    });
  });

  it("ends a run and its provider's subagents on its process's exit, cancels its approval and keeps waiting messages", async () => {
    const canceledApprovals: RunTerminalContext[] = [];
    fixture.engine.registerSetupGate({
      assertRunReady: () => Promise.resolve(),
      onRunTerminal: (context) => {
        canceledApprovals.push(context);
        return Promise.resolve();
      },
    });
    const lead = await fixture.runThrough(["starting", "running", "waiting_for_approval"]);
    const subagent = await fixture.runThrough(["starting", "running"], {
      parentRunId: lead,
      reachedBy: "provider_subagent",
    });
    const nestedSubagent = await fixture.runThrough(["starting", "running"], {
      parentRunId: subagent,
      reachedBy: "provider_subagent",
    });
    const bridged = await fixture.runThrough(["starting", "running"], {
      parentRunId: lead,
      reachedBy: "bridge_run",
    });
    const waitingMessageId = randomUUID();
    const now = new Date().toISOString();
    await fixture.database.writer.write([
      {
        sql: `INSERT INTO queue_items (id, session_id, state, created_at, updated_at)
              VALUES (?, ?, 'queued', ?, ?)`,
        bindings: [waitingMessageId, fixture.sessionId, now, now],
      },
    ]);
    const processExit: ProcessExit = {
      signal: "SIGKILL",
      outputTail: "Error: connection reset\n    at Socket.read",
    };

    await fixture.engine.endTurnOnProcessExit(lead, processExit);

    for (const runId of [lead, subagent, nestedSubagent]) {
      const ends = fixture.readRunEvents(runId).filter((row) => row.type === "run.failed");
      expect(ends).toHaveLength(1);
      expect(ends[0]?.payload).toMatchObject({
        failureCategory: "provider failure",
        processExit,
      });
    }
    expect(fixture.runs.getRun(bridged)?.state).toBe("running");
    expect(canceledApprovals.map((context) => context.runId)).toEqual([
      lead,
      subagent,
      nestedSubagent,
    ]);
    expect(canceledApprovals[0]).toMatchObject({ terminalState: "failed", runVersion: 4 });
    expect(
      fixture.database.reader
        .prepare<[string], { state: string }>("SELECT state FROM queue_items WHERE id = ?")
        .get(waitingMessageId),
    ).toEqual({ state: "queued" });
  });

  it("keeps a run's id through a wait and back, and an interrupt while it waits ends that run", async () => {
    const runId = await fixture.runThrough(["starting", "running"]);

    const waiting = await fixture.engine.transition({ runId, newState: "waiting_for_approval" });
    const resumed = await fixture.engine.transition({ runId, newState: "running" });
    await fixture.engine.transition({ runId, newState: "waiting_for_input" });
    // A steer changes no state; only the interrupt ends the run.
    await fixture.engine.settleInterventionOutcome({
      runId,
      interventionType: "steer",
      state: "applied",
    });
    expect(fixture.runs.getRun(runId)?.state).toBe("waiting_for_input");
    await fixture.engine.settleInterventionOutcome({
      runId,
      interventionType: "interrupt",
      state: "applied",
    });

    expect([waiting.version, resumed.version]).toEqual([3, 4]);
    expect(fixture.runs.getRun(runId)).toEqual({
      version: 6,
      sessionId: fixture.sessionId,
      state: "interrupted",
    });
    expect(fixture.readRunEvents(runId).map((row) => row.payload["newState"])).toEqual([
      "queued",
      "starting",
      "running",
      "waiting_for_approval",
      "running",
      "waiting_for_input",
      "interrupted",
    ]);
    expect(fixture.database.reader.prepare("SELECT COUNT(*) AS runs FROM runs").get()).toEqual({
      runs: 1,
    });
  });
});
