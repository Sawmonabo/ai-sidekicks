// The intervention service over a real database and writer: each guard refuses inside the write
// it decides, a refused or reused request dispatches nothing, and every outcome lands on the row
// with its event.

import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EventEnvelopeVersionSchema } from "@ai-sidekicks/contracts/event/envelope";
import type {
  ApplyInterventionParams,
  DriverInterventionResult,
} from "@ai-sidekicks/contracts/provider/driver/intervention";
import type {
  InterventionId,
  InterventionRequestPayload,
} from "@ai-sidekicks/contracts/run/control";
import { RunIdSchema, type RunId } from "@ai-sidekicks/contracts/run/id";
import type { RunState } from "@ai-sidekicks/contracts/run/state";
import { SessionIdSchema, type SessionId } from "@ai-sidekicks/contracts/session/id";
import { DeviceIdSchema } from "@ai-sidekicks/contracts/trust-statement";

import { openScratchDatabase, type ScratchDatabase } from "../../database/__fixtures__/scratch.js";
import { EventLogService } from "../../events/log-service.js";
import { SessionEventAppender } from "../../events/session/appender.js";
import { DaemonDomainError } from "../../ipc/domain-error.js";
import { STEER_FALLBACK_ACTION } from "../../provider/driver/contract.js";
import { insertQueuedRunStatement, swapRunStateStatement } from "../../session/run/projection.js";
import { RunStateReader } from "../../session/run/read.js";
import {
  InterventionService,
  type FasterModelRetryOutcome,
  type FasterModelRetryRequest,
  type InterventionOrigin,
  type SettledInterventionOutcome,
} from "../service.js";
import { InterventionReader } from "../store.js";

const DAEMON_ORIGIN: InterventionOrigin = { deviceId: null };

interface InterventionRow {
  readonly state: string;
  readonly payload: string;
  readonly device_id: string | null;
  readonly rejection_reason: string | null;
  readonly fallback_action: string | null;
  readonly resolved_at: string | null;
}

describe("InterventionService", () => {
  let database: ScratchDatabase;
  let runs: RunStateReader;
  let runEvents: SessionEventAppender;
  let service: InterventionService;
  let sessionId: SessionId;
  let runId: RunId;
  let driverCalls: ApplyInterventionParams[];
  let driverResult: DriverInterventionResult;
  // Runs inside the driver's dispatch, before it answers.
  let duringDispatch: () => Promise<void>;
  let retryCalls: FasterModelRetryRequest[];
  let retryOutcome: FasterModelRetryOutcome;
  let settleCalls: SettledInterventionOutcome[];

  beforeEach(async () => {
    database = await openScratchDatabase();
    const sessionEvents = new EventLogService({ writer: database.writer });
    runs = new RunStateReader(database.reader);
    runEvents = new SessionEventAppender(
      { sessionEvents },
      EventEnvelopeVersionSchema.parse("1.0"),
    );
    sessionId = SessionIdSchema.parse(randomUUID());
    runId = RunIdSchema.parse(randomUUID());
    driverCalls = [];
    driverResult = { status: "applied" };
    duringDispatch = async () => {};
    retryCalls = [];
    retryOutcome = { state: "applied" };
    settleCalls = [];
    service = new InterventionService({
      runs,
      interventions: new InterventionReader(database.reader),
      sessionEvents,
      resolveDriver: () => ({
        applyIntervention: async (params) => {
          driverCalls.push(params);
          await duringDispatch();
          return driverResult;
        },
      }),
      retryOnFasterModel: async (request) => {
        retryCalls.push(request);
        return retryOutcome;
      },
      runEngine: {
        settleInterventionOutcome: async (outcome) => {
          settleCalls.push(outcome);
        },
      },
    });

    const queued = { sessionId, runId, runVersion: 0, newState: "queued" as const };
    await runEvents.append("run.queued", queued, {
      transactionalPrelude: [insertQueuedRunStatement(queued)],
    });
  });

  afterEach(async () => {
    await database.close();
  });

  async function moveRun(previousState: RunState, newState: "running" | "waiting_for_input") {
    const runVersion = (runs.getRun(runId)?.version ?? 0) + 1;
    const swap = { sessionId, runId, runVersion, previousState, newState };
    await runEvents.append(`run.${newState}`, swap, {
      transactionalPrelude: [swapRunStateStatement(swap)],
    });
  }

  function steer(expectedRunVersion: number, content = "use the other branch") {
    return {
      type: "steer",
      targetRunId: runId,
      expectedRunVersion,
      clientIdempotencyKey: randomUUID(),
      content,
    } satisfies InterventionRequestPayload;
  }

  function fasterModelRetry(expectedRunVersion: number): FasterModelRetryRequest {
    return {
      type: "faster_model_retry",
      targetRunId: runId,
      expectedRunVersion,
      clientIdempotencyKey: randomUUID(),
      expectedTurnId: "turn-7",
      model: "gpt-5.4-mini",
    };
  }

  function readRow(interventionId: InterventionId): InterventionRow | undefined {
    return database.reader
      .prepare<[InterventionId], InterventionRow>(
        `SELECT state, payload, device_id, rejection_reason, fallback_action, resolved_at
           FROM interventions WHERE id = ?`,
      )
      .get(interventionId);
  }

  function eventTypesOf(interventionId: InterventionId): string[] {
    return database.reader
      .prepare<[string], { type: string }>(
        `SELECT type FROM session_events
          WHERE json_extract(payload, '$.interventionId') = ? ORDER BY sequence`,
      )
      .all(interventionId)
      .map((row) => row.type);
  }

  it("expires a request whose expected version is older or newer than the run's", async () => {
    await moveRun("queued", "running");

    for (const expectedRunVersion of [0, 2]) {
      const response = await service.applyIntervention(steer(expectedRunVersion), DAEMON_ORIGIN);

      expect(response).toEqual({
        interventionId: response.interventionId,
        interventionType: "steer",
        state: "expired",
        runVersion: 1,
      });
      expect(readRow(response.interventionId)).toMatchObject({
        state: "expired",
        resolved_at: expect.any(String),
      });
      expect(eventTypesOf(response.interventionId)).toEqual([
        "intervention.requested",
        "intervention.expired",
      ]);
    }
    expect(driverCalls).toHaveLength(0);
    expect(runs.getRun(runId)?.version).toBe(1);
  });

  it("rejects an interrupt on a run whose state does not end interrupted, dispatching nothing", async () => {
    const response = await service.applyIntervention(
      {
        type: "interrupt",
        targetRunId: runId,
        expectedRunVersion: 0,
        clientIdempotencyKey: randomUUID(),
        pending: "nextTurn",
      },
      DAEMON_ORIGIN,
    );

    expect(response).toMatchObject({
      state: "rejected",
      rejectionReason: "run.invalid_transition",
    });
    expect(readRow(response.interventionId)).toMatchObject({
      state: "rejected",
      rejection_reason: "run.invalid_transition",
    });
    expect(eventTypesOf(response.interventionId)).toEqual([
      "intervention.requested",
      "intervention.rejected",
    ]);
    expect(driverCalls).toHaveLength(0);
    expect(runs.getRun(runId)?.version).toBe(0);
  });

  it("lands applied and degraded on the row with one version advance each, and settles each once", async () => {
    await moveRun("queued", "running");
    const deviceId = DeviceIdSchema.parse(randomUUID());

    const applied = await service.applyIntervention(steer(1), { deviceId });
    driverResult = { status: "degraded", fallbackAction: STEER_FALLBACK_ACTION };
    const degraded = await service.applyIntervention(steer(2), DAEMON_ORIGIN);

    expect(applied).toMatchObject({ state: "applied", runVersion: 2 });
    expect(degraded).toMatchObject({ state: "degraded", runVersion: 3 });
    expect(readRow(applied.interventionId)).toMatchObject({
      state: "applied",
      device_id: deviceId,
      fallback_action: null,
    });
    expect(readRow(degraded.interventionId)).toMatchObject({
      state: "degraded",
      device_id: null,
      fallback_action: STEER_FALLBACK_ACTION,
    });
    expect(eventTypesOf(applied.interventionId)).toEqual([
      "intervention.requested",
      "intervention.accepted",
      "intervention.applied",
    ]);
    expect(eventTypesOf(degraded.interventionId)).toEqual([
      "intervention.requested",
      "intervention.accepted",
      "intervention.degraded",
    ]);
    expect(driverCalls).toEqual([
      {
        type: "steer",
        targetRunId: runId,
        expectedRunVersion: 1,
        clientIdempotencyKey: expect.any(String),
        payload: { content: "use the other branch" },
      },
      expect.objectContaining({ expectedRunVersion: 2 }),
    ]);
    expect(settleCalls).toEqual([
      { runId, interventionType: "steer", state: "applied" },
      { runId, interventionType: "steer", state: "degraded" },
    ]);
  });

  it("expires an accepted intervention when the run moved before its outcome landed", async () => {
    await moveRun("queued", "running");
    duringDispatch = () => moveRun("running", "waiting_for_input");

    const response = await service.applyIntervention(steer(1), DAEMON_ORIGIN);

    expect(response).toMatchObject({ state: "expired", runVersion: 2 });
    expect(eventTypesOf(response.interventionId)).toEqual([
      "intervention.requested",
      "intervention.accepted",
      "intervention.expired",
    ]);
    expect(driverCalls).toHaveLength(1);
    expect(settleCalls).toHaveLength(0);
  });

  it("applies concurrent requests on one run in turn, so one version reaches the driver once", async () => {
    await moveRun("queued", "running");
    const first = steer(1);
    const competing = steer(1, "use the first branch");

    const [applied, expired, retried] = await Promise.all([
      service.applyIntervention(first, DAEMON_ORIGIN),
      service.applyIntervention(competing, DAEMON_ORIGIN),
      service.applyIntervention(first, DAEMON_ORIGIN),
    ]);

    expect(applied).toMatchObject({ state: "applied", runVersion: 2 });
    expect(expired).toMatchObject({ state: "expired", runVersion: 2 });
    expect(retried).toEqual(applied);
    expect(eventTypesOf(expired.interventionId)).toEqual([
      "intervention.requested",
      "intervention.expired",
    ]);
    expect(driverCalls).toEqual([expect.objectContaining({ expectedRunVersion: 1 })]);
    expect(settleCalls).toHaveLength(1);
    expect(runs.getRun(runId)?.version).toBe(2);
  });

  it("returns the saved result for a reused key and dispatches once, and refuses a differing body", async () => {
    await moveRun("queued", "running");
    const steerRequest = steer(1);
    const first = await service.applyIntervention(steerRequest, DAEMON_ORIGIN);
    const retriedSteer = await service.applyIntervention(steerRequest, DAEMON_ORIGIN);

    const retryRequest = fasterModelRetry(2);
    const firstRetry = await service.applyIntervention(retryRequest, DAEMON_ORIGIN);
    const repeatedRetry = await service.applyIntervention(retryRequest, DAEMON_ORIGIN);

    expect(retriedSteer).toEqual(
      expect.objectContaining({ interventionId: first.interventionId, state: "applied" }),
    );
    expect(repeatedRetry).toEqual({ ...firstRetry, runVersion: 3 });
    expect(driverCalls).toHaveLength(1);
    expect(retryCalls).toHaveLength(1);

    const conflict: unknown = await service
      .applyIntervention({ ...steerRequest, content: "use the first branch" }, DAEMON_ORIGIN)
      .catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(DaemonDomainError);
    expect(conflict).toMatchObject({
      code: "intervention.idempotency_conflict",
      detail: { targetRunId: runId, interventionId: first.interventionId },
    });
    expect(readRow(first.interventionId)).toMatchObject({
      state: "applied",
      payload: JSON.stringify({ content: "use the other branch" }),
    });
    expect(driverCalls).toHaveLength(1);
  });

  it("hands an admitted faster-model retry to its leg alone, and refuses a stale one before it", async () => {
    await moveRun("queued", "running");
    const stale = await service.applyIntervention(fasterModelRetry(0), DAEMON_ORIGIN);
    expect(stale.state).toBe("expired");
    expect(retryCalls).toHaveLength(0);

    const admitted = fasterModelRetry(1);
    const applied = await service.applyIntervention(admitted, DAEMON_ORIGIN);
    retryOutcome = { state: "rejected", rejectionReason: "turn_not_latest" };
    const refused = await service.applyIntervention(fasterModelRetry(2), DAEMON_ORIGIN);

    expect(retryCalls[0]).toEqual(admitted);
    expect(retryCalls).toHaveLength(2);
    expect(driverCalls).toHaveLength(0);
    expect(applied).toMatchObject({ state: "applied", runVersion: 2 });
    expect(refused).toMatchObject({
      state: "rejected",
      rejectionReason: "turn_not_latest",
      runVersion: 2,
    });
    expect(readRow(refused.interventionId)).toMatchObject({ rejection_reason: "turn_not_latest" });
    expect(settleCalls).toEqual([
      { runId, interventionType: "faster_model_retry", state: "applied" },
    ]);
  });
});
