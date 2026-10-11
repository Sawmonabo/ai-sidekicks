// The intervention service over a real database and writer: each guard refuses inside the write
// it decides, a refused or reused request dispatches nothing, and every outcome lands on the row
// with its event.

import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentIdSchema } from "@ai-sidekicks/contracts/agent/definition";
import { EventEnvelopeVersionSchema } from "@ai-sidekicks/contracts/event/envelope";
import type {
  ApplyInterventionParams,
  DriverInterventionResult,
} from "@ai-sidekicks/contracts/provider/driver/intervention";
import type { InterventionId } from "@ai-sidekicks/contracts/run/control";
import { DAEMON_INTERVENTION_ACTOR } from "@ai-sidekicks/contracts/run/events";
import { RunIdSchema, type RunId } from "@ai-sidekicks/contracts/run/id";
import type { RunState } from "@ai-sidekicks/contracts/run/state";
import { SessionIdSchema, type SessionId } from "@ai-sidekicks/contracts/session/id";
import { DeviceIdSchema } from "@ai-sidekicks/contracts/trust-statement";

import { openScratchDatabase, type ScratchDatabase } from "../../database/__fixtures__/scratch.js";
import { EventLogService } from "../../events/log-service.js";
import { SessionEventAppender } from "../../events/session/appender.js";
import { DaemonDomainError } from "../../ipc/domain-error.js";
import { insertQueuedRunStatement, swapRunStateStatement } from "../../session/run/projection.js";
import { RunStateReader } from "../../session/run/read.js";
import type { FasterModelRetryOutcome } from "../../provider/driver/run-control.js";
import {
  InterventionService,
  type FasterModelRetryRequest,
  type InterventionOrigin,
} from "../service.js";
import { InterventionReader } from "../store.js";

const DAEMON_ORIGIN: InterventionOrigin = { actor: DAEMON_INTERVENTION_ACTOR };

interface InterventionRow {
  readonly state: string;
  readonly payload: string;
  readonly device_id: string | null;
  readonly rejection_reason: string | null;
  readonly failure_reason: string | null;
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
  // Runs inside the driver's dispatch, before it answers.
  let duringDispatch: () => Promise<void>;
  let retryCalls: FasterModelRetryRequest[];
  let retryOutcome: FasterModelRetryOutcome;

  beforeEach(async () => {
    database = await openScratchDatabase();
    const sessionEvents = new EventLogService({
      writer: database.writer,
      reader: database.reader,
      writeServiceLog: (line) => {
        throw new Error(`unexpected service log line: ${line}`);
      },
    });
    runs = new RunStateReader(database.reader);
    runEvents = new SessionEventAppender(
      { sessionEvents },
      EventEnvelopeVersionSchema.parse("1.0"),
    );
    sessionId = SessionIdSchema.parse(randomUUID());
    runId = RunIdSchema.parse(randomUUID());
    driverCalls = [];
    duringDispatch = async () => {};
    retryCalls = [];
    retryOutcome = { state: "applied" };
    service = new InterventionService({
      runs,
      interventions: new InterventionReader(database.reader),
      sessionEvents,
      resolveDriver: () => ({
        applyIntervention: (params) => {
          driverCalls.push(params);
          return Promise.resolve<DriverInterventionResult>({ status: "applied" });
        },
      }),
      retryOnFasterModel: async (request) => {
        retryCalls.push(request);
        await duringDispatch();
        return retryOutcome;
      },
      runEngine: { routeInterrupt: () => Promise.resolve("driver") },
      // No run here has messages waiting, and none an interrupt dispatched to here ends.
      queue: {
        holdForInterrupt: () => Promise.resolve(),
        withdrawForInterrupt: () => Promise.resolve(),
        endRunForInterrupt: () => Promise.reject(new Error("No run ends in these tests")),
        releaseInterrupt: () => Promise.resolve(),
      },
    });

    const queued = {
      sessionId,
      runId,
      runVersion: 0,
      newState: "queued" as const,
      agentId: AgentIdSchema.parse(randomUUID()),
    };
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

  function fasterModelRetry(
    expectedRunVersion: number,
    model = "gpt-5.4-mini",
  ): FasterModelRetryRequest {
    return {
      type: "faster_model_retry",
      targetRunId: runId,
      expectedRunVersion,
      clientIdempotencyKey: randomUUID(),
      expectedTurnId: "turn-7",
      model,
    };
  }

  function readRow(interventionId: InterventionId): InterventionRow | undefined {
    return database.reader
      .prepare<[InterventionId], InterventionRow>(
        `SELECT state, payload, device_id, rejection_reason, failure_reason, fallback_action,
                resolved_at
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

  // The actor each of an intervention's events names, on its envelope and in its payload.
  function eventActorsOf(interventionId: InterventionId): (string | null)[][] {
    return database.reader
      .prepare<[string], { actor: string | null; payload_actor: string | null }>(
        `SELECT actor, json_extract(payload, '$.actor') AS payload_actor FROM session_events
          WHERE json_extract(payload, '$.interventionId') = ? ORDER BY sequence`,
      )
      .all(interventionId)
      .map((row) => [row.actor, row.payload_actor]);
  }

  it("expires a request whose expected version is older or newer than the run's", async () => {
    await moveRun("queued", "running");

    for (const expectedRunVersion of [0, 2]) {
      const response = await service.applyIntervention(
        fasterModelRetry(expectedRunVersion),
        DAEMON_ORIGIN,
      );

      expect(response).toEqual({
        interventionId: response.interventionId,
        interventionType: "faster_model_retry",
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
    expect(retryCalls).toHaveLength(0);
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

  it("hands an admitted retry to its leg alone, landing applied and rejected on the row", async () => {
    await moveRun("queued", "running");
    const deviceId = DeviceIdSchema.parse(randomUUID());

    const admitted = fasterModelRetry(1);
    const applied = await service.applyIntervention(admitted, { actor: deviceId });
    retryOutcome = { state: "rejected", rejectionReason: "turn_not_latest" };
    const rejected = await service.applyIntervention(fasterModelRetry(2), DAEMON_ORIGIN);

    expect(applied).toMatchObject({ state: "applied", runVersion: 2 });
    expect(rejected).toMatchObject({ state: "rejected", runVersion: 2 });
    expect(readRow(applied.interventionId)).toMatchObject({
      state: "applied",
      device_id: deviceId,
    });
    expect(readRow(rejected.interventionId)).toMatchObject({
      state: "rejected",
      device_id: null,
      rejection_reason: "turn_not_latest",
    });
    // Every event names who asked, the calling device or the daemon, on its envelope too.
    expect(eventActorsOf(applied.interventionId)).toEqual(Array(3).fill([deviceId, deviceId]));
    expect(eventActorsOf(rejected.interventionId)).toEqual(
      Array(3).fill([DAEMON_INTERVENTION_ACTOR, DAEMON_INTERVENTION_ACTOR]),
    );
    expect(eventTypesOf(applied.interventionId)).toEqual([
      "intervention.requested",
      "intervention.accepted",
      "intervention.applied",
    ]);
    expect(eventTypesOf(rejected.interventionId)).toEqual([
      "intervention.requested",
      "intervention.accepted",
      "intervention.rejected",
    ]);
    // An admitted retry goes to its leg as asked, and never to the driver.
    expect(retryCalls).toEqual([admitted, expect.objectContaining({ expectedRunVersion: 2 })]);
    expect(driverCalls).toHaveLength(0);
  });

  it("records the retry's verdict when the run moved after dispatch, advancing from where it is", async () => {
    await moveRun("queued", "running");
    duringDispatch = () => moveRun("running", "waiting_for_input");

    const response = await service.applyIntervention(fasterModelRetry(1), DAEMON_ORIGIN);

    expect(response).toMatchObject({ state: "applied", runVersion: 3 });
    expect(readRow(response.interventionId)).toMatchObject({ state: "applied" });
    expect(eventTypesOf(response.interventionId)).toEqual([
      "intervention.requested",
      "intervention.accepted",
      "intervention.applied",
    ]);
    expect(runs.getRun(runId)).toMatchObject({ state: "waiting_for_input", version: 3 });
    expect(retryCalls).toHaveLength(1);
  });

  it.each([
    {
      thrown: new DaemonDomainError("The provider's transport closed", {
        code: "driver.transport_closed",
      }),
      failureReason: "driver.transport_closed",
    },
    { thrown: new Error("  socket hang up\0  "), failureReason: "socket hang up" },
  ])(
    "ends a request failed with $failureReason when its dispatch throws, and answers it and a retry with it",
    async ({ thrown, failureReason }) => {
      await moveRun("queued", "running");
      duringDispatch = () => Promise.reject(thrown);
      const request = fasterModelRetry(1);

      const failed = await service.applyIntervention(request, DAEMON_ORIGIN);
      const retried = await service.applyIntervention(request, DAEMON_ORIGIN);

      expect(failed).toEqual({
        interventionId: failed.interventionId,
        interventionType: "faster_model_retry",
        state: "failed",
        failureReason,
        runVersion: 1,
      });
      expect(retried).toEqual(failed);
      expect(readRow(retried.interventionId)).toMatchObject({
        state: "failed",
        failure_reason: failureReason,
        resolved_at: expect.any(String),
      });
      expect(eventTypesOf(retried.interventionId)).toEqual([
        "intervention.requested",
        "intervention.accepted",
        "intervention.failed",
      ]);
      // The failed event says what the answer and the row say.
      expect(
        database.reader
          .prepare<[string], { failure_reason: string }>(
            `SELECT json_extract(payload, '$.failureReason') AS failure_reason
               FROM session_events
              WHERE type = 'intervention.failed'
                AND json_extract(payload, '$.interventionId') = ?`,
          )
          .get(retried.interventionId),
      ).toEqual({ failure_reason: failureReason });
      expect(retryCalls).toHaveLength(1);
    },
  );

  it("applies concurrent requests on one run in turn, so one version reaches the driver once", async () => {
    await moveRun("queued", "running");
    const first = fasterModelRetry(1);
    const competing = fasterModelRetry(1, "gpt-5.4");

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
    expect(retryCalls).toEqual([expect.objectContaining({ expectedRunVersion: 1 })]);
    expect(runs.getRun(runId)?.version).toBe(2);
  });

  it("returns the saved result for a reused key and dispatches once, and refuses a differing body", async () => {
    await moveRun("queued", "running");
    const retryRequest = fasterModelRetry(1);
    const first = await service.applyIntervention(retryRequest, DAEMON_ORIGIN);
    const repeated = await service.applyIntervention(retryRequest, DAEMON_ORIGIN);

    expect(repeated).toEqual(first);
    expect(retryCalls).toHaveLength(1);

    const conflict: unknown = await service
      .applyIntervention({ ...retryRequest, model: "gpt-5.4" }, DAEMON_ORIGIN)
      .catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(DaemonDomainError);
    expect(conflict).toMatchObject({
      code: "intervention.idempotency_conflict",
      detail: { targetRunId: runId, interventionId: first.interventionId },
    });
    expect(readRow(first.interventionId)).toMatchObject({
      state: "applied",
      payload: JSON.stringify({ expectedTurnId: "turn-7", model: "gpt-5.4-mini" }),
    });
    expect(retryCalls).toHaveLength(1);
  });
});
