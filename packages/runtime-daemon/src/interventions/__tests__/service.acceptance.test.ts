// The intervention service, the run engine and the inbound dispatch composed over one scratch
// database, with the driver and the faster-model retry as the only doubles: a person's interrupt
// ends the run once without waiting behind a retry, and a stale or late arrival changes nothing.

import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DriverInterventionResult } from "@ai-sidekicks/contracts/provider/driver/intervention";
import type {
  InterventionId,
  InterventionRequestPayload,
  InterventionRequestResponse,
} from "@ai-sidekicks/contracts/run/control";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import { DeviceIdSchema, type DeviceId } from "@ai-sidekicks/contracts/trust-statement";

import { makeSilentDriverDiagnostics } from "../../provider/__fixtures__/silent-driver-diagnostics.js";
import { CodexRequestTimeoutError } from "../../provider/driver/codex/session/errors.js";
import type { DriverDiagnosticsEmitter } from "../../provider/driver/diagnostics.js";
import type {
  FasterModelRetryOutcome,
  ApplyInterventionParams,
} from "../../provider/driver/run-control.js";
import type { InterruptRoute } from "../../session/run/engine.js";
import { ExecutionEpochs } from "../../session/run/epochs.js";
import { RunInboundDispatch } from "../../session/run/inbound.js";
import {
  TEST_EXECUTION_POSTURE,
  makeEngineInterruptQueue,
  makeQueueItem,
  makeRecordingDriver,
  startOnDriver,
  openRunEngineFixture,
  type RunEngineFixture,
  refuseDriverInterrupt,
} from "../../session/run/__tests__/engine.test-support.js";
import { InterventionService } from "../service.js";
import { InterventionReader } from "../store.js";

interface InterventionRow {
  readonly state: string;
  readonly device_id: string | null;
}

describe("intervention service with the run engine and inbound dispatch", () => {
  let fixture: RunEngineFixture;
  let diagnostics: DriverDiagnosticsEmitter;
  let service: InterventionService;
  let driverCalls: ApplyInterventionParams[];
  let driverResult: DriverInterventionResult;
  // Answers each driver call; the default answers at once with `driverResult`.
  let answerDriver: (params: ApplyInterventionParams) => Promise<DriverInterventionResult>;
  // Routes each interrupt the service sends; the default is the engine's own route.
  let routeInterrupt: (runId: RunId) => Promise<InterruptRoute>;
  // Answers each faster-model retry; the default refuses, since most tests send none.
  let answerRetry: () => Promise<FasterModelRetryOutcome>;

  beforeEach(async () => {
    fixture = await openRunEngineFixture();
    diagnostics = makeSilentDriverDiagnostics();
    driverCalls = [];
    driverResult = { status: "applied" };
    answerDriver = () => Promise.resolve(driverResult);
    routeInterrupt = (runId) => fixture.engine.routeInterrupt(runId);
    answerRetry = () => Promise.reject(new Error("No faster-model retry is sent here"));
    service = new InterventionService({
      runs: fixture.runs,
      interventions: new InterventionReader(fixture.database.reader),
      sessionEvents: fixture.sessionEvents,
      resolveDriver: () => ({
        applyIntervention: (params) => {
          driverCalls.push(params);
          return answerDriver(params);
        },
      }),
      retryOnFasterModel: () => answerRetry(),
      runEngine: { routeInterrupt: (runId) => routeInterrupt(runId) },
      queue: makeEngineInterruptQueue(fixture.engine),
    });
  });

  afterEach(async () => {
    await fixture.close();
  });

  function interrupt(runId: RunId, expectedRunVersion: number) {
    return {
      type: "interrupt",
      targetRunId: runId,
      expectedRunVersion,
      clientIdempotencyKey: randomUUID(),
      pending: "returnToDraft",
    } satisfies InterventionRequestPayload;
  }

  function fasterModelRetry(runId: RunId, expectedRunVersion: number) {
    return {
      type: "faster_model_retry",
      targetRunId: runId,
      expectedRunVersion,
      clientIdempotencyKey: randomUUID(),
      expectedTurnId: "turn-7",
      model: "gpt-5.4-mini",
    } satisfies InterventionRequestPayload;
  }

  function readIntervention(interventionId: InterventionId): InterventionRow | undefined {
    return fixture.database.reader
      .prepare<
        [InterventionId],
        InterventionRow
      >("SELECT state, device_id FROM interventions WHERE id = ?")
      .get(interventionId);
  }

  // Every event the session's log holds, run and intervention alike, in log order.
  function readSessionEventTypes(): string[] {
    return fixture.database.reader
      .prepare<[string], { type: string }>(
        "SELECT type FROM session_events WHERE session_id = ? ORDER BY sequence",
      )
      .all(fixture.sessionId)
      .map((row) => row.type);
  }

  function readVersion(runId: RunId): number {
    const run = fixture.runs.getRun(runId);
    if (run === undefined) {
      throw new Error(`Run ${runId} has no row`);
    }
    return run.version;
  }

  function countTerminals(runId: RunId): number {
    return fixture.readRunEvents(runId).filter((row) => row.type === "run.interrupted").length;
  }

  // A run started through the engine past one setup gate, interrupted from a device; the gate's
  // terminal hook counts its calls.
  async function interruptStartedRun(): Promise<{
    runId: RunId;
    deviceId: DeviceId;
    runningVersion: number;
    interruptedVersion: number;
    countTerminalHooks: () => number;
  }> {
    let terminalHookCalls = 0;
    fixture.engine.registerSetupGate({
      assertRunReady: () => Promise.resolve(),
      onRunTerminal: () => {
        terminalHookCalls += 1;
        return Promise.resolve();
      },
    });
    const runId = await fixture.queueRun();
    const running = await fixture.engine.startRun({
      runId,
      queueItem: makeQueueItem(),
      provider: "claude",
      outputSpeed: undefined,
      interruptDriver: refuseDriverInterrupt,
      startDriver: startOnDriver(makeRecordingDriver(), runId),
      executionPosture: TEST_EXECUTION_POSTURE,
    });
    const deviceId = DeviceIdSchema.parse(randomUUID());

    const response = await service.applyIntervention(interrupt(runId, running.version), {
      actor: deviceId,
    });

    expect(response).toMatchObject({ interventionType: "interrupt", state: "applied" });
    expect(readIntervention(response.interventionId)).toMatchObject({
      state: "applied",
      device_id: deviceId,
    });
    expect(readSessionEventTypes()).toEqual([
      "session.created",
      "run.queued",
      "run.starting",
      "run.running",
      "intervention.requested",
      "intervention.accepted",
      "intervention.applied",
      "run.interrupted",
    ]);
    const lastRunEvent = fixture.readRunEvents(runId).at(-1);
    const interruptedVersion = Number(lastRunEvent?.payload["runVersion"]);
    expect(fixture.runs.getRun(runId)).toMatchObject({
      state: "interrupted",
      version: interruptedVersion,
    });
    expect(terminalHookCalls).toBe(1);
    expect(driverCalls).toHaveLength(1);
    return {
      runId,
      deviceId,
      runningVersion: running.version,
      interruptedVersion,
      countTerminalHooks: () => terminalHookCalls,
    };
  }

  // Mutation: recording the interrupted turn's own end as a late event adds a third diagnostic.
  it("ends the run interrupted once, and absorbs the provider's late lifecycle events", async () => {
    const { runId, interruptedVersion, countTerminalHooks } = await interruptStartedRun();
    const epochs = new ExecutionEpochs({ diagnostics });
    const inbound = new RunInboundDispatch({
      engine: fixture.engine,
      epochs,
      diagnostics,
      sessionEvents: fixture.sessionEvents,
      runStatePublisher: { publish: () => undefined },
    });
    const bindingId = randomUUID();
    epochs.openBinding({ id: bindingId, runId, driverName: "claude" }, { epoch: 0, position: 1 });
    const eventsBefore = readSessionEventTypes();

    const lateCompleted = await inbound.dispatch({
      kind: "run_lifecycle",
      bindingId,
      change: { runId, newState: "completed", completionKind: "turn" },
    });
    const lateRunning = await inbound.dispatch({
      kind: "run_lifecycle",
      bindingId,
      change: { runId, newState: "running" },
    });
    // The stopped turn's own end, which the interrupt's verdict wrote first, is no late event.
    const interruptEnd = await inbound.dispatch({
      kind: "run_lifecycle",
      bindingId,
      change: { runId, newState: "interrupted" },
      isDaemonInterruptEnd: true,
    });

    expect(lateCompleted).toEqual({ disposition: "absorbed", reason: "run_ended" });
    expect(lateRunning).toEqual({ disposition: "absorbed", reason: "run_ended" });
    expect(interruptEnd).toEqual({ disposition: "absorbed", reason: "run_ended" });
    expect(readSessionEventTypes()).toEqual(eventsBefore);
    expect(fixture.runs.getRun(runId)).toMatchObject({
      state: "interrupted",
      version: interruptedVersion,
    });
    expect(countTerminalHooks()).toBe(1);
    expect(
      diagnostics.recentRecordsOfKind("late_event_absorbed").map((record) => record.details),
    ).toEqual([
      expect.objectContaining({ reason: "run_ended", runId, newState: "completed" }),
      expect.objectContaining({ reason: "run_ended", runId, newState: "running" }),
    ]);
  });

  it("expires a second interrupt that read the run's old version, dispatching nothing", async () => {
    const { runId, deviceId, runningVersion, interruptedVersion, countTerminalHooks } =
      await interruptStartedRun();

    const second = await service.applyIntervention(interrupt(runId, runningVersion), {
      actor: deviceId,
    });

    expect(second).toMatchObject({ state: "expired", runVersion: interruptedVersion });
    expect(readIntervention(second.interventionId)).toMatchObject({ state: "expired" });
    expect(driverCalls).toHaveLength(1);
    expect(countTerminals(runId)).toBe(1);
    expect(countTerminalHooks()).toBe(1);
    expect(fixture.runs.getRun(runId)).toMatchObject({
      state: "interrupted",
      version: interruptedVersion,
    });
  });

  it.each([
    { heldState: "pausing", path: ["starting", "running", "pausing"] },
    { heldState: "paused", path: ["starting", "running", "pausing", "paused"] },
  ] as const)("ends a $heldState run interrupted", async ({ heldState, path }) => {
    const runId = await fixture.runThrough(path);
    expect(fixture.runs.getRun(runId)?.state).toBe(heldState);

    const response = await service.applyIntervention(interrupt(runId, readVersion(runId)), {
      actor: DeviceIdSchema.parse(randomUUID()),
    });

    expect(response.state).toBe("applied");
    expect(fixture.runs.getRun(runId)?.state).toBe("interrupted");
    expect(countTerminals(runId)).toBe(1);
  });

  it("ends a run interrupted while its setup gate is still pending, and the gate's release lets the start end", async () => {
    // A gate that waits until the run ends, as one waiting on a setup step's retry would.
    const gateCalled = Promise.withResolvers<void>();
    const gateReady = Promise.withResolvers<void>();
    fixture.engine.registerSetupGate({
      assertRunReady: () => {
        gateCalled.resolve();
        return gateReady.promise;
      },
      onRunTerminal: () => {
        gateReady.resolve();
        return Promise.resolve();
      },
    });
    const runId = await fixture.queueRun();
    const providerDriver = makeRecordingDriver();
    const started = fixture.engine
      .startRun({
        runId,
        queueItem: makeQueueItem(),
        provider: "claude",
        outputSpeed: undefined,
        interruptDriver: refuseDriverInterrupt,
        startDriver: startOnDriver(providerDriver, runId),
        executionPosture: TEST_EXECUTION_POSTURE,
      })
      .catch((error: unknown) => error);
    await gateCalled.promise;
    // As a real driver answers a stop for a run it was never handed.
    answerDriver = () => Promise.reject(new Error("No live run to interrupt"));

    const stop = await service.applyIntervention(interrupt(runId, readVersion(runId)), {
      actor: DeviceIdSchema.parse(randomUUID()),
    });

    expect(stop).toMatchObject({ interventionType: "interrupt", state: "applied" });
    expect(fixture.runs.getRun(runId)?.state).toBe("interrupted");
    expect(await started).toMatchObject({
      code: "run.invalid_transition",
      fromState: "interrupted",
    });
    expect(driverCalls).toEqual([]);
    expect(providerDriver.startedRuns).toEqual([]);
    expect(countTerminals(runId)).toBe(1);
  });

  // Starts a run on a driver that binds it as its start returns, as Codex's does once `turn/start`
  // answers, and refuses to stop a run it has not bound; then sends a stop and resolves once the
  // stop is routed, inside the start's window. `settleStart` ends the driver's start.
  async function holdStopInDriverStart(): Promise<{
    runId: RunId;
    settleStart: PromiseWithResolvers<void>;
    started: Promise<unknown>;
    stop: Promise<InterventionRequestResponse>;
  }> {
    const boundRuns = new Set<RunId>();
    answerDriver = (params) =>
      boundRuns.has(params.targetRunId)
        ? Promise.resolve(driverResult)
        : Promise.reject(new Error("No live run to interrupt"));
    const startCalled = Promise.withResolvers<void>();
    const settleStart = Promise.withResolvers<void>();
    const runId = await fixture.queueRun();
    const started = fixture.engine
      .startRun({
        runId,
        queueItem: makeQueueItem(),
        provider: "codex",
        outputSpeed: undefined,
        interruptDriver: refuseDriverInterrupt,
        startDriver: async () => {
          startCalled.resolve();
          await settleStart.promise;
          boundRuns.add(runId);
        },
        executionPosture: TEST_EXECUTION_POSTURE,
      })
      .catch((error: unknown) => error);
    await startCalled.promise;
    const routed = Promise.withResolvers<void>();
    routeInterrupt = (routedRunId) => {
      const route = fixture.engine.routeInterrupt(routedRunId);
      routed.resolve();
      return route;
    };
    const stop = service.applyIntervention(interrupt(runId, readVersion(runId)), {
      actor: DeviceIdSchema.parse(randomUUID()),
    });
    await routed.promise;
    return { runId, settleStart, started, stop };
  }

  it("holds a stop that lands while the driver starts the run until the driver has it", async () => {
    const held = await holdStopInDriverStart();
    held.settleStart.resolve();

    expect(await held.stop).toMatchObject({ interventionType: "interrupt", state: "applied" });
    expect(await held.started).toMatchObject({ state: "running" });
    expect(fixture.runs.getRun(held.runId)?.state).toBe("interrupted");
    expect(driverCalls.map((params) => params.targetRunId)).toEqual([held.runId]);
  });

  it("expires a held stop when the driver's start rejects, as one does at its request deadline", async () => {
    const held = await holdStopInDriverStart();
    // The error a start throws at its deadline; the hold reads any rejected start the same way.
    const deadline = new CodexRequestTimeoutError("turn/start was not answered in time");
    held.settleStart.reject(deadline);

    expect(await held.stop).toMatchObject({ interventionType: "interrupt", state: "expired" });
    expect(await held.started).toBe(deadline);
    expect(fixture.runs.getRun(held.runId)?.state).toBe("failed");
    expect(driverCalls).toEqual([]);
  });

  it("lets the engine end a run whose failed start could not write its end, for a stop that waited or came after", async () => {
    // Every failed end is refused, so a failed start leaves its run `starting` with no driver.
    await fixture.database.writer.write([
      {
        sql: `CREATE TRIGGER refuse_run_failed BEFORE INSERT ON session_events
                WHEN NEW.type = 'run.failed'
                BEGIN SELECT RAISE(ABORT, 'refused for the test'); END`,
      },
    ]);
    const held = await holdStopInDriverStart();
    held.settleStart.reject(new Error("spawn codex ENOENT"));

    expect(await held.stop).toMatchObject({ interventionType: "interrupt", state: "applied" });
    expect(await held.started).toBeInstanceOf(AggregateError);
    expect(fixture.runs.getRun(held.runId)?.state).toBe("interrupted");

    const runId = await fixture.queueRun();
    const started = await fixture.engine
      .startRun({
        runId,
        queueItem: makeQueueItem(),
        provider: "codex",
        outputSpeed: undefined,
        interruptDriver: refuseDriverInterrupt,
        startDriver: startOnDriver(
          { startRun: () => Promise.reject(new Error("spawn codex ENOENT")) },
          runId,
        ),
        executionPosture: TEST_EXECUTION_POSTURE,
      })
      .catch((error: unknown) => error);
    expect(started).toBeInstanceOf(AggregateError);
    expect(fixture.runs.getRun(runId)?.state).toBe("starting");

    const stop = await service.applyIntervention(interrupt(runId, readVersion(runId)), {
      actor: DeviceIdSchema.parse(randomUUID()),
    });

    expect(stop).toMatchObject({ interventionType: "interrupt", state: "applied" });
    expect(fixture.runs.getRun(runId)?.state).toBe("interrupted");
    expect(driverCalls).toEqual([]);
  });

  it("expires a stop that lands while a failed setup gate's end is written, dispatching nothing", async () => {
    const gateCalled = Promise.withResolvers<void>();
    const gateReady = Promise.withResolvers<void>();
    const terminalHookEntered = Promise.withResolvers<void>();
    const terminalHookReleased = Promise.withResolvers<void>();
    fixture.engine.registerSetupGate({
      assertRunReady: () => {
        gateCalled.resolve();
        return gateReady.promise;
      },
      onRunTerminal: () => {
        terminalHookEntered.resolve();
        return terminalHookReleased.promise;
      },
    });
    const runId = await fixture.queueRun();
    const started = fixture.engine
      .startRun({
        runId,
        queueItem: makeQueueItem(),
        provider: "claude",
        outputSpeed: undefined,
        interruptDriver: refuseDriverInterrupt,
        startDriver: startOnDriver(makeRecordingDriver(), runId),
        executionPosture: TEST_EXECUTION_POSTURE,
      })
      .catch((error: unknown) => error);
    await gateCalled.promise;
    // As a real driver answers a stop for a run it was never handed.
    answerDriver = () => Promise.reject(new Error("No live run to interrupt"));
    const gateError = new Error("git worktree add failed");
    // Routed once the gate has thrown and while the run's failed end is still being written.
    routeInterrupt = async (routedRunId) => {
      gateReady.reject(gateError);
      await terminalHookEntered.promise;
      const route = fixture.engine.routeInterrupt(routedRunId);
      terminalHookReleased.resolve();
      return route;
    };

    const stop = await service.applyIntervention(interrupt(runId, readVersion(runId)), {
      actor: DeviceIdSchema.parse(randomUUID()),
    });

    expect(stop).toMatchObject({ interventionType: "interrupt", state: "expired" });
    expect(await started).toBe(gateError);
    expect(fixture.runs.getRun(runId)?.state).toBe("failed");
    expect(driverCalls).toEqual([]);
  });

  it("dispatches a stop past a stuck retry, keeps the retry's verdict, and expires the retry behind it", async () => {
    const runId = await fixture.runThrough(["starting", "running"]);
    const runningVersion = readVersion(runId);
    const origin = { actor: DeviceIdSchema.parse(randomUUID()) };
    const stuckRetryCalled = Promise.withResolvers<void>();
    const stuckRetryOutcome = Promise.withResolvers<FasterModelRetryOutcome>();
    let retryCalls = 0;
    answerRetry = () => {
      retryCalls += 1;
      stuckRetryCalled.resolve();
      return stuckRetryOutcome.promise;
    };

    const stuckRetry = service.applyIntervention(fasterModelRetry(runId, runningVersion), origin);
    await stuckRetryCalled.promise;
    const queuedRetry = service.applyIntervention(fasterModelRetry(runId, runningVersion), origin);
    const stop = await service.applyIntervention(interrupt(runId, runningVersion), origin);

    // The stop reached the driver and ended the run while the first retry was still in dispatch.
    expect(driverCalls.map((params) => params.type)).toEqual(["interrupt"]);
    expect(stop).toMatchObject({ interventionType: "interrupt", state: "applied" });
    expect(fixture.runs.getRun(runId)?.state).toBe("interrupted");
    expect(countTerminals(runId)).toBe(1);
    const interruptedVersion = readVersion(runId);

    stuckRetryOutcome.resolve({ state: "applied" });
    const [stuck, queued] = await Promise.all([stuckRetry, queuedRetry]);

    expect(stuck).toMatchObject({ state: "applied" });
    expect(readIntervention(stuck.interventionId)).toMatchObject({ state: "applied" });
    // The verdict that landed after the run's end moved nothing past it.
    expect(stuck.runVersion).toBe(interruptedVersion);
    expect(queued).toMatchObject({ state: "expired", runVersion: interruptedVersion });
    expect(readIntervention(queued.interventionId)).toMatchObject({ state: "expired" });
    expect(retryCalls).toBe(1);
    expect(fixture.runs.getRun(runId)).toMatchObject({
      state: "interrupted",
      version: interruptedVersion,
    });
    expect(fixture.readRunEvents(runId).at(-1)).toMatchObject({
      type: "run.interrupted",
      payload: { runVersion: interruptedVersion },
    });
  });
});
