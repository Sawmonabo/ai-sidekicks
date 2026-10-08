// A rebuild over a real database writes exactly the `runs` rows the live writes wrote, an
// interrupt verdict that found its run already ended included, and a second rebuild writes them
// again unchanged. The runs fold drops a terminal event it has already
// folded, fails on a different terminal at the same run version, and takes a terminal at a later
// run version as the run's next end.

import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SessionEventSchema } from "@ai-sidekicks/contracts/event/session";
import type { SessionEvent } from "@ai-sidekicks/contracts/event/variant-types";
import { EventEnvelopeVersionSchema } from "@ai-sidekicks/contracts/event/envelope";
import { InterventionIdSchema, type InterventionId } from "@ai-sidekicks/contracts/run/control";
import {
  DAEMON_INTERVENTION_ACTOR,
  type InterventionEventPayload,
} from "@ai-sidekicks/contracts/run/events";
import { RunIdSchema, type RunId } from "@ai-sidekicks/contracts/run/id";
import { SessionIdSchema } from "@ai-sidekicks/contracts/session/id";

import { SessionEventAppender } from "../../events/session/appender.js";
import { InterventionService } from "../../interventions/service.js";
import { InterventionReader, moveInterventionStatement } from "../../interventions/store.js";
import {
  openRunEngineFixture,
  type RunEngineFixture,
} from "../../session/run/__tests__/engine.test-support.js";
import { advanceRunVersionStatement, RUNS_PROJECTION } from "../../session/run/projection.js";
import { SessionService } from "../../session/service.js";
import { ProjectionFailureError, ProjectionRebuildService } from "../projection-rebuild.js";

describe("projection rebuild over the session log", () => {
  let fixture: RunEngineFixture;

  beforeEach(async () => {
    fixture = await openRunEngineFixture();
  });

  afterEach(async () => {
    await fixture.close();
  });

  async function insertAcceptedIntervention(
    runId: RunId,
    type: "interrupt" | "steer",
  ): Promise<InterventionId> {
    const interventionId = InterventionIdSchema.parse(randomUUID());
    await fixture.database.writer.write([
      {
        sql: `INSERT INTO interventions
                (id, target_run_id, type, state, expected_run_version, client_idempotency_key,
                 created_at)
              VALUES (?, ?, ?, 'accepted', 2, ?, ?)`,
        bindings: [interventionId, runId, type, randomUUID(), new Date().toISOString()],
      },
    ]);
    return interventionId;
  }

  // An applied steer, written as the intervention service writes it: the version advance, the
  // row's move and the event in one write.
  async function applySteer(runId: RunId): Promise<void> {
    const interventionId = await insertAcceptedIntervention(runId, "steer");
    const applied: InterventionEventPayload<"applied"> = {
      sessionId: fixture.sessionId,
      interventionId,
      targetRunId: runId,
      type: "steer",
      state: "applied",
      actor: DAEMON_INTERVENTION_ACTOR,
    };
    await new SessionEventAppender(
      { sessionEvents: fixture.sessionEvents },
      EventEnvelopeVersionSchema.parse("1.0"),
    ).append("intervention.applied", applied, {
      transactionalPrelude: [
        advanceRunVersionStatement({ sessionId: fixture.sessionId, runId }),
        moveInterventionStatement(interventionId, { from: "accepted", to: "applied" }),
      ],
    });
  }

  // An accepted interrupt the restart settle applies, ending its run in the verdict's write.
  async function applyInterrupt(runId: RunId): Promise<void> {
    await insertAcceptedIntervention(runId, "interrupt");
    const run = fixture.runs.listLiveRuns().find((liveRun) => liveRun.runId === runId);
    if (run === undefined) {
      throw new Error(`Run ${runId} is not live`);
    }
    await fixture.engine.settleRunAfterRestart(run, "The service restarted");
  }

  // An interrupt the driver applies after the run has ended on its own, through the intervention
  // service, which then writes the verdict alone.
  async function interruptRunThatEnds(runId: RunId): Promise<void> {
    const run = fixture.runs.getRun(runId);
    if (run === undefined) {
      throw new Error(`Run ${runId} has no row`);
    }
    const service = new InterventionService({
      runs: fixture.runs,
      interventions: new InterventionReader(fixture.database.reader),
      sessionEvents: fixture.sessionEvents,
      resolveDriver: () => ({
        applyIntervention: async () => {
          await fixture.engine.transition({ runId, newState: "stopped" });
          return { status: "applied" };
        },
      }),
      retryOnFasterModel: () => Promise.reject(new Error("No faster-model retry is sent here")),
      runEngine: {
        endRunForInterrupt: (id, verdict) => fixture.engine.endRunForInterrupt(id, verdict),
        routeInterrupt: (id) => fixture.engine.routeInterrupt(id),
      },
    });
    const response = await service.applyIntervention(
      {
        type: "interrupt",
        targetRunId: runId,
        expectedRunVersion: run.version,
        clientIdempotencyKey: randomUUID(),
        pending: "returnToDraft",
      },
      { actor: DAEMON_INTERVENTION_ACTOR },
    );
    expect(response.state).toBe("applied");
  }

  function readRuns(): unknown[] {
    return fixture.database.reader.prepare("SELECT * FROM runs ORDER BY run_id").all();
  }

  it("writes the rows the live writes wrote, and the same rows again on a second rebuild", async () => {
    const ended = await fixture.runThrough(["starting", "running", "interrupted"]);
    await fixture.runThrough(["starting"], { parentRunId: ended, reachedBy: "provider_subagent" });
    const steered = await fixture.runThrough(["starting", "running"]);
    await applySteer(steered);
    const interrupted = await fixture.runThrough(["starting", "running"]);
    await applyInterrupt(interrupted);
    const endedFirst = await fixture.runThrough(["starting", "running"]);
    await interruptRunThatEnds(endedFirst);
    await fixture.queueRun();
    const liveRows = readRuns();
    // The rebuild must write every row itself, so none is left from the live writes.
    await fixture.database.writer.write([{ sql: "DELETE FROM runs" }]);
    const rebuild = new ProjectionRebuildService({
      reader: fixture.database.reader,
      writer: fixture.database.writer,
      sessionEvents: new SessionService(fixture.database.reader),
      projections: [RUNS_PROJECTION],
    });

    const first = await rebuild.rebuild({ sessionId: fixture.sessionId, force: true });
    const rowsAfterFirst = readRuns();
    const second = await rebuild.rebuild({ sessionId: fixture.sessionId, force: true });

    expect(rowsAfterFirst).toStrictEqual(liveRows);
    expect(readRuns()).toStrictEqual(rowsAfterFirst);
    expect(second).toStrictEqual(first);
    expect(first.rebuiltProjections).toStrictEqual(["runs"]);
    expect(
      fixture.database.reader
        .prepare(`SELECT last_sequence, state FROM projection_cursors WHERE session_id = ?`)
        .get(fixture.sessionId),
    ).toStrictEqual({ last_sequence: first.asOfSequence, state: "current" });
  });

  it("drops a terminal it has folded, fails on a different one at its version, and takes a later one", () => {
    const sessionId = SessionIdSchema.parse(randomUUID());
    const runId = RunIdSchema.parse(randomUUID());
    let sequence = 0;
    const runEvent = (type: string, payload: Record<string, unknown>, id = randomUUID()) =>
      SessionEventSchema.parse({
        id,
        sessionId,
        sequence: sequence++,
        occurredAt: "2026-10-07T12:00:00.000Z",
        category: "run_lifecycle",
        type,
        actor: null,
        payload: { sessionId, runId, ...payload },
        version: "1.0",
      });
    const change = (runVersion: number, previousState: string, newState: string): SessionEvent =>
      runEvent(`run.${newState}`, { runVersion, previousState, newState });
    const fold = RUNS_PROJECTION.createFold(sessionId);
    for (const event of [
      runEvent("run.queued", { runVersion: 0, newState: "queued" }),
      change(1, "queued", "starting"),
      change(2, "starting", "running"),
    ]) {
      fold.apply(event);
    }
    const terminal = change(3, "running", "interrupted");

    expect(fold.apply(terminal)).toHaveLength(1);
    expect(fold.apply(terminal)).toStrictEqual([]);
    expect(() => fold.apply(change(3, "running", "failed"))).toThrow(ProjectionFailureError);
    fold.apply(change(4, "interrupted", "running"));
    expect(fold.apply(change(5, "running", "interrupted"))).toHaveLength(1);
  });
});
