// A restart's recovery pass over a real database: a run the restart left running ends failed and
// needing recovery, a run whose interrupt was accepted ends interrupted with the interrupt applied,
// a session whose log cannot be folded leaves the node degraded, and each pass is recorded as one
// attempt more than the failed passes before it. While the node is not healthy a mutating call is
// refused with `daemon.write_refused`, and the restart is still taken.

import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  DAEMON_SCOPE_SENTINEL_SESSION_ID,
  EventEnvelopeVersionSchema,
} from "@ai-sidekicks/contracts/event/envelope";
import { RunIdSchema, type RunId } from "@ai-sidekicks/contracts/run/id";
import { NodeIdSchema } from "@ai-sidekicks/contracts/runtime-node/id";
import { SessionIdSchema } from "@ai-sidekicks/contracts/session/id";

import { SessionEventAppender } from "../../events/session/appender.js";
import { MethodRegistryImpl } from "../../ipc/registry.js";
import {
  openRunEngineFixture,
  type RunEngineFixture,
} from "../../session/run/__tests__/engine.test-support.js";
import { RUNS_PROJECTION } from "../../session/run/projection.js";
import { SessionService } from "../../session/service.js";
import { ProjectionRebuildService } from "../projection-rebuild.js";
import { StartupRecovery } from "../startup.js";
import { RecoveryStatusTracker } from "../status.js";
import { RecoveryWriteGate } from "../write-gate.js";

describe("the recovery pass at a restart", () => {
  let fixture: RunEngineFixture;

  beforeEach(async () => {
    fixture = await openRunEngineFixture();
  });

  afterEach(async () => {
    await fixture.close();
  });

  async function acceptInterrupt(runId: RunId): Promise<string> {
    const interventionId = randomUUID();
    await fixture.database.writer.write([
      {
        sql: `INSERT INTO interventions
                (id, target_run_id, type, state, expected_run_version, client_idempotency_key,
                 created_at)
              VALUES (?, ?, 'interrupt', 'accepted', 2, ?, ?)`,
        bindings: [interventionId, runId, randomUUID(), new Date().toISOString()],
      },
    ]);
    return interventionId;
  }

  // A session whose log holds a run's start with no queued run before it, which no live write
  // would have written, so its rows cannot be rebuilt.
  async function writeUnfoldableSession(): Promise<string> {
    const sessionId = SessionIdSchema.parse(randomUUID());
    await new SessionEventAppender(
      { sessionEvents: fixture.sessionEvents },
      EventEnvelopeVersionSchema.parse("1.0"),
    ).append(
      "run.starting",
      {
        sessionId,
        runId: RunIdSchema.parse(randomUUID()),
        runVersion: 1,
        previousState: "queued",
        newState: "starting",
      },
      {},
    );
    return sessionId;
  }

  function startupRecovery(status: RecoveryStatusTracker): StartupRecovery {
    const { reader, writer } = fixture.database;
    return new StartupRecovery({
      nodeId: NodeIdSchema.parse(randomUUID()),
      reader,
      sessionEvents: fixture.sessionEvents,
      projectionRebuild: new ProjectionRebuildService({
        reader,
        writer,
        sessionEvents: new SessionService(reader),
        projections: [RUNS_PROJECTION],
      }),
      runs: fixture.runs,
      runEngine: fixture.restartEngine(),
      status,
      now: () => new Date("2026-10-07T12:00:00.000Z"),
      writeServiceLog: () => {},
    });
  }

  function readRecoveryEvents(): { type: string; payload: Record<string, unknown> }[] {
    return fixture.database.reader
      .prepare<[string], { type: string; payload: string }>(
        "SELECT type, payload FROM session_events WHERE session_id = ? ORDER BY sequence",
      )
      .all(DAEMON_SCOPE_SENTINEL_SESSION_ID)
      .map((row) => ({
        type: row.type,
        payload: JSON.parse(row.payload) as Record<string, unknown>,
      }));
  }

  it("ends each live run, leaves the node degraded by the session it cannot rebuild, and counts the attempts", async () => {
    const crashed = await fixture.runThrough(["starting", "running"]);
    const stopped = await fixture.runThrough(["starting", "running"]);
    const interventionId = await acceptInterrupt(stopped);
    const queued = await fixture.queueRun();
    const unfoldable = await writeUnfoldableSession();
    // Every session is rebuilt, as on a store whose projection cursors are gone.
    await fixture.database.writer.write([{ sql: "DELETE FROM projection_cursors" }]);
    const status = new RecoveryStatusTracker();

    await startupRecovery(status).run();

    expect(fixture.readRunEvents(crashed).at(-1)).toMatchObject({
      type: "run.failed",
      payload: { failureCategory: "provider failure", recoveryCondition: "recovery-needed" },
    });
    expect(fixture.readRunEvents(stopped).at(-1)?.type).toBe("run.interrupted");
    expect(
      fixture.database.reader
        .prepare("SELECT state FROM interventions WHERE id = ?")
        .get(interventionId),
    ).toStrictEqual({ state: "applied" });
    expect(fixture.runs.getRun(queued)?.state).toBe("queued");
    expect(status.read()).toStrictEqual({
      overall: "degraded",
      sessions: [
        { sessionId: unfoldable, state: "degraded", failureCategory: "projection failure" },
      ],
    });

    await startupRecovery(new RecoveryStatusTracker()).run();

    expect(readRecoveryEvents()).toMatchObject([
      { type: "recovery.attempted", payload: { attemptNumber: 1, priorFailureCount: 0 } },
      {
        type: "recovery.failed",
        payload: { attemptNumber: 1, failureKind: "projection_rebuild_failed" },
      },
      { type: "recovery.attempted", payload: { attemptNumber: 2, priorFailureCount: 1 } },
      { type: "recovery.failed", payload: { attemptNumber: 2 } },
    ]);
  });

  it("refuses a mutating call while the node is not healthy and still takes the restart", async () => {
    const status = new RecoveryStatusTracker();
    const registry = new RecoveryWriteGate(() => status.readOverall()).wrap(
      new MethodRegistryImpl(),
    );
    const emptyObject = z.object({}).strict();
    for (const method of ["run.intervene", "daemon.restart"]) {
      registry.register(method, emptyObject, emptyObject, () => Promise.resolve({}), {
        mutating: true,
      });
    }

    await expect(registry.dispatch("run.intervene", {}, {})).rejects.toMatchObject({
      code: "daemon.write_refused",
      detail: { recovery: "rebuilding" },
    });
    await expect(registry.dispatch("daemon.restart", {}, {})).resolves.toStrictEqual({});

    await startupRecovery(status).run();

    await expect(registry.dispatch("run.intervene", {}, {})).resolves.toStrictEqual({});
  });
});
