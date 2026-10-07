// A run state change over a real database: one terminal per run version however two terminals
// race, a move that loses its race retried from the state the winner left or refused when the table
// forbids it there, and a move the table does not allow refused with nothing written.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EventEnvelopeVersionSchema } from "@ai-sidekicks/contracts/event/envelope";
import type { RunId } from "@ai-sidekicks/contracts/run/id";

import { WriteRefusedError } from "../../../database/writer.js";
import { SessionEventAppender } from "../../../events/session/appender.js";
import type { RunTransitionRequest } from "../engine.js";
import { RunAlreadyEndedError, RunInvalidTransitionError } from "../refusals.js";
import { openRunEngineFixture, type RunEngineFixture } from "./engine.test-support.js";

// A change named before its run exists, one member of the union at a time.
type ChangeWithoutRun = RunTransitionRequest extends infer Change
  ? Change extends unknown
    ? Omit<Change, "runId">
    : never
  : never;

describe("run state change", () => {
  let fixture: RunEngineFixture;

  beforeEach(async () => {
    fixture = await openRunEngineFixture();
  });

  afterEach(async () => {
    await fixture.close();
  });

  function terminalTypes(runId: RunId): string[] {
    return fixture
      .readRunEvents(runId)
      .map((row) => row.type)
      .filter((type) =>
        ["run.completed", "run.failed", "run.interrupted", "run.stopped"].includes(type),
      );
  }

  it("commits one of two terminals decided from one read and refuses the other as already ended", async () => {
    const runId = await fixture.runThrough(["starting", "running"]);

    // Both calls read the run before either writes, so both are composed at the same version.
    const outcomes = await Promise.allSettled([
      fixture.engine.transition({ runId, newState: "completed", completionKind: "turn" }),
      fixture.engine.transition({ runId, newState: "failed", failureCategory: "provider failure" }),
    ]);

    expect(outcomes[0]).toEqual({
      status: "fulfilled",
      value: { version: 3, sessionId: fixture.sessionId, state: "completed" },
    });
    expect(outcomes[1]?.status).toBe("rejected");
    const refusal = (outcomes[1] as PromiseRejectedResult).reason as unknown;
    expect(refusal).toBeInstanceOf(RunAlreadyEndedError);
    // Refused by the terminal guard reading the first terminal, not by the swap or the index.
    expect((refusal as RunAlreadyEndedError).cause).toBeInstanceOf(WriteRefusedError);
    expect((refusal as RunAlreadyEndedError).cause).toMatchObject({
      statementIndex: 0,
      rowCount: 1,
    });
    expect(terminalTypes(runId)).toEqual(["run.completed"]);
    expect(fixture.runs.getRun(runId)).toEqual({
      version: 3,
      sessionId: fixture.sessionId,
      state: "completed",
    });
  });

  it("retries the loser of two moves decided from one read while the table still allows it", async () => {
    const runId = await fixture.runThrough(["starting", "running"]);

    // Both read the run running at version 2; the second's swap meets the first's row, and the
    // move is still allowed from the state the first left, so it is written after it.
    await Promise.all([
      fixture.engine.transition({ runId, newState: "waiting_for_approval" }),
      fixture.engine.transition({ runId, newState: "waiting_for_input" }),
    ]);

    expect(
      fixture.readRunEvents(runId).map((row) => [row.type, row.payload["runVersion"]]),
    ).toEqual([
      ["run.queued", 0],
      ["run.starting", 1],
      ["run.running", 2],
      ["run.waiting_for_approval", 3],
      ["run.waiting_for_input", 4],
    ]);
    expect(fixture.runs.getRun(runId)).toMatchObject({ state: "waiting_for_input", version: 4 });
  });

  it("refuses the loser of two moves from the state the winner left when the table forbids it", async () => {
    const runId = await fixture.runThrough(["starting", "running"]);

    const outcomes = await Promise.allSettled([
      fixture.engine.transition({ runId, newState: "pausing" }),
      fixture.engine.transition({ runId, newState: "waiting_for_approval" }),
    ]);

    expect(outcomes[0]?.status).toBe("fulfilled");
    const refusal = (outcomes[1] as PromiseRejectedResult).reason as unknown;
    expect(refusal).toBeInstanceOf(RunInvalidTransitionError);
    expect(refusal).not.toBeInstanceOf(RunAlreadyEndedError);
    expect(refusal).toMatchObject({ fromState: "pausing", toState: "waiting_for_approval" });
    expect(fixture.runs.getRun(runId)).toMatchObject({ state: "pausing", version: 3 });

    // A terminal that loses its swap to a live move is refused the same way, past its own guard.
    const otherRunId = await fixture.runThrough(["starting", "running"]);
    const [, terminalOutcome] = await Promise.allSettled([
      fixture.engine.transition({ runId: otherRunId, newState: "pausing" }),
      fixture.engine.transition({
        runId: otherRunId,
        newState: "completed",
        completionKind: "turn",
      }),
    ]);
    const terminalRefusal = (terminalOutcome as PromiseRejectedResult).reason as unknown;
    expect(terminalRefusal).toBeInstanceOf(RunInvalidTransitionError);
    expect(terminalRefusal).not.toBeInstanceOf(RunAlreadyEndedError);
    expect(terminalRefusal).toMatchObject({ fromState: "pausing", toState: "completed" });
    expect(fixture.runs.getRun(otherRunId)).toMatchObject({ state: "pausing", version: 3 });
  });

  it("never re-opens a run whose end won the race against a provider's live move", async () => {
    const runId = await fixture.runThrough(["starting", "running", "waiting_for_approval"]);

    // The provider's `running` read the run waiting, then lost its swap to the person's interrupt;
    // `interrupted -> running` is in the table, so only the retry's ended-run check refuses it.
    const [, providerOutcome] = await Promise.allSettled([
      fixture.engine.transition({ runId, newState: "interrupted" }),
      fixture.engine.applyProviderStateChange({ runId, newState: "running" }),
    ]);

    const refusal = (providerOutcome as PromiseRejectedResult).reason as unknown;
    expect(refusal).toBeInstanceOf(RunInvalidTransitionError);
    expect(refusal).toMatchObject({ fromState: "interrupted", toState: "running" });
    expect(fixture.runs.getRun(runId)).toMatchObject({ state: "interrupted", version: 4 });
    expect(
      fixture
        .readRunEvents(runId)
        .map((row) => row.type)
        .slice(-2),
    ).toEqual(["run.waiting_for_approval", "run.interrupted"]);
  });

  it("refuses a terminal its run version already holds even while the row still reads live", async () => {
    const runId = await fixture.runThrough(["starting", "running"]);
    // A terminal record at the next version, appended with no swap, so only the guard can see it.
    const appender = new SessionEventAppender(
      { sessionEvents: fixture.sessionEvents },
      EventEnvelopeVersionSchema.parse("1.0"),
    );
    const payload = {
      sessionId: fixture.sessionId,
      runId,
      runVersion: 3,
      previousState: "running",
      newState: "completed",
      completionKind: "turn",
    };
    await appender.append("run.completed", payload, {});

    const refusal: unknown = await fixture.engine
      .transition({ runId, newState: "interrupted" })
      .catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(RunAlreadyEndedError);
    expect((refusal as RunAlreadyEndedError).cause).toMatchObject({
      statementIndex: 0,
      rowCount: 1,
    });
    expect(terminalTypes(runId)).toEqual(["run.completed"]);
    expect(fixture.runs.getRun(runId)?.state).toBe("running");
  });

  it.each<{
    readonly name: string;
    readonly path: Parameters<RunEngineFixture["runThrough"]>[0];
    readonly change: ChangeWithoutRun;
    readonly hasRunEnded: boolean;
  }>([
    {
      name: "a skip from queued straight to running",
      path: [],
      change: { newState: "running" },
      hasRunEnded: false,
    },
    {
      name: "a resume of a run that is not paused",
      path: ["starting", "running"],
      change: { newState: "running", expectedState: "paused" },
      hasRunEnded: false,
    },
    {
      name: "a move out of failed, which has no exit",
      path: ["starting", "failed"],
      change: { newState: "running" },
      hasRunEnded: false,
    },
    {
      name: "a late completion of an interrupted run",
      path: ["starting", "running", "interrupted"],
      change: { newState: "completed", completionKind: "turn" },
      hasRunEnded: true,
    },
  ])("refuses $name with nothing written", async ({ path, change, hasRunEnded }) => {
    const runId = await fixture.runThrough(path);
    const before = { run: fixture.runs.getRun(runId), events: fixture.readRunEvents(runId) };

    const error: unknown = await fixture.engine
      .transition({ ...change, runId } as RunTransitionRequest)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(RunInvalidTransitionError);
    expect(error instanceof RunAlreadyEndedError).toBe(hasRunEnded);
    expect(error).toMatchObject({ code: "run.invalid_transition" });
    expect(fixture.runs.getRun(runId)).toEqual(before.run);
    expect(fixture.readRunEvents(runId)).toEqual(before.events);
  });
});
