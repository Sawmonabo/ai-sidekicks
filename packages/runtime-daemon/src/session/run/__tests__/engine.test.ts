// The run engine over a real database: the setup gates around a run's start, the terminal hooks,
// a provider process that ends on its own, a run that waits and comes back on its own id, the
// notice a run gets when its provider does not run it at the fast output level it carried, and
// the interrupt a restart's settle writes for a held child or for the person's pending one, and a
// turn the daemon starts itself, run as the session's own run.

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";
import type { ProcessExit } from "@ai-sidekicks/contracts/run/control";
import type { RunId } from "@ai-sidekicks/contracts/run/id";

import { RunAlreadyEndedError, RunInvalidTransitionError } from "../refusals.js";
import { DaemonDomainError } from "../../../ipc/domain-error.js";
import type { RunSetupGate, RunTerminalContext } from "../setup-gates.js";
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
      provider: "claude",
      driver: makeRecordingDriver(),
      driverParams: { agentConfig: {} },
      executionPosture: TEST_EXECUTION_POSTURE,
    });
  }

  describe("setup gates", () => {
    it("runs gates in order before the driver, handing it and stamping the resolved posture", async () => {
      const ungated = await fixture.queueRun();
      await startRun(ungated);
      expect(fixture.runs.getRun(ungated)?.state).toBe("running");

      // A writable root reached through a link, which only the posture gate resolves.
      const scratch = await mkdtemp(path.join(tmpdir(), "engine-posture-"));
      const realRoot = path.join(scratch, "worktree");
      const linkedRoot = path.join(scratch, "worktree-link");
      await mkdir(realRoot);
      await symlink(realRoot, linkedRoot);
      const log: string[] = [];
      fixture.engine.registerSetupGate(recordingGate("first", log));
      fixture.engine.registerSetupGate(recordingGate("second", log));
      const driver = makeRecordingDriver();
      const originalStart = driver.startRun;
      const gated = await fixture.queueRun();
      await fixture.engine.startRun({
        runId: gated,
        queueItem: makeQueueItem(),
        provider: "claude",
        driver: {
          startRun: async (params) => {
            log.push("driver");
            await originalStart(params);
          },
        },
        driverParams: { agentConfig: {} },
        executionPosture: { ...TEST_EXECUTION_POSTURE, writableRoots: [linkedRoot] },
      });

      const resolved = { ...TEST_EXECUTION_POSTURE, writableRoots: [await realpath(realRoot)] };
      await rm(scratch, { recursive: true, force: true });
      expect(log).toEqual(["first ready", "second ready", "driver"]);
      const running = fixture.readRunEvents(gated).at(-1);
      expect(running?.type).toBe("run.running");
      expect(running?.payload["executionPosture"]).toEqual(resolved);
      expect(driver.startedRuns[0]?.executionPosture).toEqual(resolved);
    });

    it("ends a run failed with a gate's error as its cause, starting no later gate or driver", async () => {
      const gateError = new DaemonDomainError("The session's workspace is not ready", {
        code: "workspace.execution_root_unresolved",
      });
      const log: string[] = [];
      fixture.engine.registerSetupGate({
        assertRunReady: () => Promise.reject(gateError),
      });
      fixture.engine.registerSetupGate(recordingGate("after", log));
      const driver = makeRecordingDriver();
      const runId = await fixture.queueRun();

      const thrown: unknown = await fixture.engine
        .startRun({
          runId,
          queueItem: makeQueueItem(),
          provider: "claude",
          driver,
          driverParams: { agentConfig: {} },
          executionPosture: TEST_EXECUTION_POSTURE,
        })
        .catch((error: unknown) => error);

      expect(thrown).toBe(gateError);
      expect(fixture.readRunEvents(runId).at(-1)).toEqual({
        type: "run.failed",
        payload: {
          sessionId: fixture.sessionId,
          runId,
          runVersion: 2,
          previousState: "starting",
          newState: "failed",
          failureCategory: "setup failure",
          failureCause: {
            cause: "setup-failed",
            origin: "daemon",
            code: "workspace.execution_root_unresolved",
            message: "The session's workspace is not ready",
          },
        },
      });
      expect(driver.startedRuns).toEqual([]);
      expect(log).toEqual(["after terminal"]);
    });

    it("never hands the driver a run an interrupt claimed in its gates, nor fails it for the gate", async () => {
      const gates = new Map<RunId, PromiseWithResolvers<void>>();
      fixture.engine.registerSetupGate({
        assertRunReady: (context) => {
          const gate = Promise.withResolvers<void>();
          gates.set(context.runId, gate);
          return gate.promise;
        },
      });
      const driver = makeRecordingDriver();
      const start = (runId: RunId) =>
        fixture.engine
          .startRun({
            runId,
            queueItem: makeQueueItem(),
            provider: "claude",
            driver,
            driverParams: { agentConfig: {} },
            executionPosture: TEST_EXECUTION_POSTURE,
          })
          .catch((error: unknown) => error);
      const passing = await fixture.queueRun();
      const throwing = await fixture.queueRun();
      const passingStart = start(passing);
      const throwingStart = start(throwing);
      while (gates.size < 2) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      expect(await fixture.engine.routeInterrupt(passing)).toBe("claimed");
      expect(await fixture.engine.routeInterrupt(throwing)).toBe("claimed");
      gates.get(passing)?.resolve();
      const gateError = new Error("git worktree add failed");
      gates.get(throwing)?.reject(gateError);

      expect(await passingStart).toMatchObject({ code: "run.invalid_transition" });
      expect(await throwingStart).toBe(gateError);
      expect(driver.startedRuns).toEqual([]);
      // The interrupt that claimed each run ends it; the gate's throw does not, and until that
      // end lands a later interrupt is the engine's too, never a driver's.
      expect(fixture.runs.getRun(throwing)?.state).toBe("starting");
      expect(await fixture.engine.routeInterrupt(passing)).toBe("claimed");
    });

    it("keeps the interrupt's end when a gate throws after an interrupt landed", async () => {
      const runId = await fixture.queueRun();
      const gateError = new Error("git worktree add failed");
      const terminals: RunTerminalContext[] = [];
      fixture.engine.registerSetupGate({
        assertRunReady: async () => {
          await fixture.engine.endRunForInterrupt(runId, {});
          throw gateError;
        },
        onRunTerminal: (context) => {
          terminals.push(context);
          return Promise.resolve();
        },
      });

      await expect(
        fixture.engine.startRun({
          runId,
          queueItem: makeQueueItem(),
          provider: "claude",
          driver: makeRecordingDriver(),
          driverParams: { agentConfig: {} },
          executionPosture: TEST_EXECUTION_POSTURE,
        }),
      ).rejects.toBe(gateError);
      expect(fixture.runs.getRun(runId)?.state).toBe("interrupted");
      expect(fixture.readRunEvents(runId).some((row) => row.type === "run.failed")).toBe(false);
      expect(terminals.map((context) => context.terminalState)).toEqual(["interrupted"]);
    });

    it("does not hand the driver a run interrupted while a gate checked it", async () => {
      const runId = await fixture.queueRun();
      fixture.engine.registerSetupGate({
        assertRunReady: async () => {
          await fixture.engine.endRunForInterrupt(runId, {});
        },
      });
      const driver = makeRecordingDriver();

      await expect(
        fixture.engine.startRun({
          runId,
          queueItem: makeQueueItem(),
          provider: "claude",
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
          provider: "claude",
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

      await fixture.engine.endRunForInterrupt(runId, {});
      // A second terminal of the same run version is refused and releases nothing again.
      await expect(
        fixture.engine.transition({ runId, newState: "interrupted" }),
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

    it("leaves a run the provider ended first as it is when the interrupt's end arrives, and surfaces any other refusal", async () => {
      const log: string[] = [];
      fixture.engine.registerSetupGate(recordingGate("gate", log));
      const runId = await fixture.queueRun();
      await startRun(runId);
      await fixture.engine.applyProviderStateChange({
        runId,
        newState: "completed",
        completionKind: "turn",
      });

      await expect(fixture.engine.endRunForInterrupt(runId, {})).resolves.toBe(false);

      expect(fixture.runs.getRun(runId)).toMatchObject({ state: "completed", version: 3 });
      expect(fixture.readRunEvents(runId).some((row) => row.type === "run.interrupted")).toBe(
        false,
      );
      expect(log).toEqual(["gate ready", "gate terminal"]);

      // A run that has not ended and cannot end interrupted is still refused.
      const queued = await fixture.queueRun();
      const refusal: unknown = await fixture.engine
        .endRunForInterrupt(queued, {})
        .catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(RunInvalidTransitionError);
      expect(refusal).not.toBeInstanceOf(RunAlreadyEndedError);
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

  it("ends a run and its provider's subagents on its process's exit, running each one's terminal hook, where a held approval is canceled", async () => {
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
    // Bridged children run in processes of their own, beneath the lead and beneath a subagent.
    const bridged = await fixture.runThrough(["starting", "running"], {
      parentRunId: lead,
      reachedBy: "bridge_run",
    });
    const bridgedUnderSubagent = await fixture.runThrough(["starting", "running"], {
      parentRunId: subagent,
      reachedBy: "bridge_run",
    });
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
    expect(fixture.runs.getRun(bridgedUnderSubagent)?.state).toBe("running");
    expect(canceledApprovals.map((context) => context.runId)).toEqual([
      lead,
      subagent,
      nestedSubagent,
    ]);
    expect(canceledApprovals[0]).toMatchObject({ terminalState: "failed", runVersion: 4 });
  });

  it("keeps a run's id through a wait and back, and an interrupt while it waits ends that run", async () => {
    const runId = await fixture.runThrough(["starting", "running"]);

    const waiting = await fixture.engine.transition({ runId, newState: "waiting_for_approval" });
    const resumed = await fixture.engine.transition({ runId, newState: "running" });
    await fixture.engine.transition({ runId, newState: "waiting_for_input" });
    await fixture.engine.endRunForInterrupt(runId, {});

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

  it("starts a daemon turn as the session's own run, a change its start reports landing after running", async () => {
    const reported: Promise<unknown>[] = [];
    const startedRunIds: RunId[] = [];

    await fixture.engine.startDaemonTurn({
      sessionId: fixture.sessionId,
      provider: "claude",
      admittedProviderAccountId: null,
      executionPosture: TEST_EXECUTION_POSTURE,
      startTurn: async (runId) => {
        startedRunIds.push(runId);
        // A turn that ends at once reports its end before the engine has written `running`.
        reported.push(
          fixture.engine.applyProviderStateChange({
            runId,
            expectedState: "running",
            newState: "completed",
            completionKind: "turn",
          }),
        );
        await Promise.resolve();
      },
    });
    await Promise.all(reported);

    const [startedRunId] = startedRunIds;
    if (startedRunId === undefined) {
      throw new Error("expected the turn to start under a run id");
    }
    const runEvents = fixture.readRunEvents(startedRunId);
    expect(runEvents.map((event) => event.type)).toEqual([
      "run.queued",
      "run.starting",
      "run.running",
      "run.completed",
    ]);
    // The session's own run is the lead's.
    expect(runEvents[0]?.payload["agentId"]).toBe(fixture.agentId);
  });

  describe("fast output notice", () => {
    async function startRunAt(provider: ProviderName, outputSpeed: string): Promise<RunId> {
      const runId = await fixture.queueRun();
      await fixture.engine.startRun({
        runId,
        queueItem: makeQueueItem(),
        provider,
        driver: makeRecordingDriver(),
        driverParams: { agentConfig: {}, outputSpeed },
        executionPosture: TEST_EXECUTION_POSTURE,
      });
      return runId;
    }

    function readNotices(): Record<string, unknown>[] {
      return fixture.database.reader
        .prepare<[], { payload: string }>(
          "SELECT payload FROM session_events WHERE type = 'session.notice'",
        )
        .all()
        .map((row) => JSON.parse(row.payload) as Record<string, unknown>);
    }

    it("appends one notice with the provider's reason for a session whose very first run is denied", async () => {
      const runId = await startRunAt("claude", "on");

      await fixture.engine.recordSettledOutputSpeed(fixture.sessionId, runId, {
        declared: "cooldown",
        reason: "Fast mode is cooling down after a rate limit",
      });

      expect(readNotices()).toEqual([
        {
          sessionId: fixture.sessionId,
          kind: "fast_output_unavailable",
          runId,
          reason: "Fast mode is cooling down after a rate limit",
        },
      ]);
    });

    it("appends nothing for a run that settles at the level it carried", async () => {
      const runId = await startRunAt("claude", "on");

      await fixture.engine.recordSettledOutputSpeed(fixture.sessionId, runId, { declared: "on" });

      expect(readNotices()).toEqual([]);
    });

    it("appends exactly one notice for a later run that carried fast output and settles at standard", async () => {
      const acceptedRunId = await startRunAt("codex", "priority");
      await fixture.engine.recordSettledOutputSpeed(fixture.sessionId, acceptedRunId, {
        declared: "priority",
      });
      await fixture.engine.transition({
        runId: acceptedRunId,
        newState: "completed",
        completionKind: "turn",
      });
      const deniedRunId = await startRunAt("codex", "priority");

      for (let report = 0; report < 2; report += 1) {
        await fixture.engine.recordSettledOutputSpeed(fixture.sessionId, deniedRunId, {
          declared: "default",
        });
      }

      expect(readNotices()).toEqual([
        { sessionId: fixture.sessionId, kind: "fast_output_unavailable", runId: deniedRunId },
      ]);
    });
  });

  describe("interrupt after a restart", () => {
    // The person's interrupt of `runId`, accepted and waiting for its outcome.
    async function requestInterrupt(runId: RunId, expectedRunVersion: number): Promise<void> {
      await fixture.database.writer.write([
        {
          sql: `INSERT INTO interventions
                  (id, target_run_id, type, state, expected_run_version, client_idempotency_key,
                   created_at)
                VALUES (?, ?, 'interrupt', 'accepted', ?, ?, ?)`,
          bindings: [
            randomUUID(),
            runId,
            expectedRunVersion,
            randomUUID(),
            new Date().toISOString(),
          ],
        },
      ]);
    }

    async function settleEveryLiveRun(): Promise<void> {
      const restarted = fixture.restartEngine();
      for (const live of fixture.runs.listLiveRuns()) {
        await restarted.settleRunAfterRestart(live, "The conversation file was not found");
      }
    }

    function readInterrupted(runId: RunId): Record<string, unknown>[] {
      return fixture
        .readRunEvents(runId)
        .filter((row) => row.type === "run.interrupted")
        .map((row) => row.payload);
    }

    it("ends a child the restart left held as the daemon's own interrupt", async () => {
      const parent = await fixture.runThrough(["starting", "running"]);
      const heldChild = await fixture.runThrough(["starting", "running", "pausing", "paused"], {
        parentRunId: parent,
        reachedBy: "provider_subagent",
      });

      await settleEveryLiveRun();

      expect(readInterrupted(heldChild)).toEqual([
        {
          sessionId: fixture.sessionId,
          runId: heldChild,
          runVersion: 5,
          previousState: "paused",
          newState: "interrupted",
          trigger: "daemon_restart",
        },
      ]);
    });

    it("keeps the person's pending interrupt theirs, held child or not", async () => {
      const stopped = await fixture.runThrough(["starting", "running"]);
      await requestInterrupt(stopped, 2);
      const heldChild = await fixture.runThrough(["starting", "running", "pausing", "paused"], {
        parentRunId: stopped,
        reachedBy: "provider_subagent",
      });
      await requestInterrupt(heldChild, 4);

      await settleEveryLiveRun();

      for (const runId of [stopped, heldChild]) {
        const interrupted = readInterrupted(runId);
        expect(interrupted).toHaveLength(1);
        expect(interrupted[0]).toMatchObject({ runId, newState: "interrupted" });
        expect(interrupted[0]).not.toHaveProperty("trigger");
      }
    });
  });
});
