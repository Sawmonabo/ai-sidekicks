// The intervention service, the run engine and the inbound dispatch composed over one scratch
// database, with the driver as the only double: a person's interrupt ends the run once, a stale or
// late arrival changes nothing, and an unsupported steer lands as an explicit degraded outcome.

import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  ApplyInterventionParams,
  DriverInterventionResult,
} from "@ai-sidekicks/contracts/provider/driver/intervention";
import type {
  InterventionId,
  InterventionRequestPayload,
} from "@ai-sidekicks/contracts/run/control";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import { DeviceIdSchema, type DeviceId } from "@ai-sidekicks/contracts/trust-statement";

import { makeSilentDriverDiagnostics } from "../../provider/__fixtures__/silent-driver-diagnostics.js";
import { STEER_FALLBACK_ACTION } from "../../provider/driver/contract.js";
import type { DriverDiagnosticsEmitter } from "../../provider/driver/diagnostics.js";
import { ExecutionEpochs } from "../../session/run/epochs.js";
import { RunInboundDispatch } from "../../session/run/inbound.js";
import {
  TEST_EXECUTION_POSTURE,
  makeQueueItem,
  makeRecordingDriver,
  openRunEngineFixture,
  type RunEngineFixture,
} from "../../session/run/__tests__/engine.test-support.js";
import { InterventionService } from "../service.js";
import { InterventionReader } from "../store.js";

interface InterventionRow {
  readonly state: string;
  readonly device_id: string | null;
  readonly fallback_action: string | null;
}

describe("intervention service with the run engine and inbound dispatch", () => {
  let fixture: RunEngineFixture;
  let diagnostics: DriverDiagnosticsEmitter;
  let service: InterventionService;
  let driverCalls: ApplyInterventionParams[];
  let driverResult: DriverInterventionResult;

  beforeEach(async () => {
    fixture = await openRunEngineFixture();
    diagnostics = makeSilentDriverDiagnostics();
    driverCalls = [];
    driverResult = { status: "applied" };
    service = new InterventionService({
      runs: fixture.runs,
      interventions: new InterventionReader(fixture.database.reader),
      sessionEvents: fixture.sessionEvents,
      resolveDriver: () => ({
        applyIntervention: (params) => {
          driverCalls.push(params);
          return Promise.resolve(driverResult);
        },
      }),
      retryOnFasterModel: () => Promise.reject(new Error("No faster-model retry is sent here")),
      runEngine: fixture.engine,
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

  function steer(runId: RunId, expectedRunVersion: number) {
    return {
      type: "steer",
      targetRunId: runId,
      expectedRunVersion,
      clientIdempotencyKey: randomUUID(),
      content: "use the other branch",
    } satisfies InterventionRequestPayload;
  }

  function readIntervention(interventionId: InterventionId): InterventionRow | undefined {
    return fixture.database.reader
      .prepare<[InterventionId], InterventionRow>(
        `SELECT state, device_id, fallback_action FROM interventions
          WHERE id = ?`,
      )
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
      driver: makeRecordingDriver(),
      driverParams: { agentConfig: {} },
      executionPosture: TEST_EXECUTION_POSTURE,
    });
    const deviceId = DeviceIdSchema.parse(randomUUID());

    const response = await service.applyIntervention(interrupt(runId, running.version), {
      deviceId,
    });

    expect(response).toMatchObject({ interventionType: "interrupt", state: "applied" });
    expect(readIntervention(response.interventionId)).toMatchObject({
      state: "applied",
      device_id: deviceId,
    });
    expect(readSessionEventTypes()).toEqual([
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

  it("ends the run interrupted once, and absorbs the provider's late lifecycle events", async () => {
    const { runId, interruptedVersion, countTerminalHooks } = await interruptStartedRun();
    const epochs = new ExecutionEpochs({ diagnostics });
    const inbound = new RunInboundDispatch({
      engine: fixture.engine,
      epochs,
      diagnostics,
      sessionEvents: fixture.sessionEvents,
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

    expect(lateCompleted).toEqual({ disposition: "absorbed", reason: "run_ended" });
    expect(lateRunning).toEqual({ disposition: "absorbed", reason: "run_ended" });
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

    const second = await service.applyIntervention(interrupt(runId, runningVersion), { deviceId });

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
      deviceId: DeviceIdSchema.parse(randomUUID()),
    });

    expect(response.state).toBe("applied");
    expect(fixture.runs.getRun(runId)?.state).toBe("interrupted");
    expect(countTerminals(runId)).toBe(1);
  });

  it("lands an unsupported steer as degraded with its fallback, whoever sent it", async () => {
    const runId = await fixture.runThrough(["starting", "running"]);

    const fromDaemon = await service.applyIntervention(steer(runId, readVersion(runId)), {
      deviceId: null,
    });
    driverResult = { status: "degraded", fallbackAction: STEER_FALLBACK_ACTION };
    const deviceId = DeviceIdSchema.parse(randomUUID());
    const degraded = await service.applyIntervention(steer(runId, fromDaemon.runVersion), {
      deviceId,
    });

    expect(fromDaemon).toMatchObject({ state: "applied" });
    expect(readIntervention(fromDaemon.interventionId)).toMatchObject({
      state: "applied",
      device_id: null,
    });
    expect(degraded).toMatchObject({ state: "degraded", runVersion: fromDaemon.runVersion + 1 });
    expect(readIntervention(degraded.interventionId)).toEqual({
      state: "degraded",
      device_id: deviceId,
      fallback_action: STEER_FALLBACK_ACTION,
    });
    expect(fixture.runs.getRun(runId)).toEqual({
      sessionId: fixture.sessionId,
      state: "running",
      version: fromDaemon.runVersion + 1,
    });
    expect(fixture.readRunEvents(runId).at(-1)?.type).toBe("run.running");
  });
});
