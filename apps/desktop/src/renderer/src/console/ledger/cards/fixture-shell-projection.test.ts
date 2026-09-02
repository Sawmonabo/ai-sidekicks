import { describe, expect, it } from "vitest";

import { TimelineRowSchema } from "@ai-sidekicks/contracts";

import { type ConsoleSessionEvent } from "../../store/index.js";
import { projectFixtureShellRows } from "./fixture-shell-projection.js";

const SESSION_ID = "019b793b-7b60-75e5-8510-ada11a5a44a5";
const RUN_ONE = "019b793b-7b60-740e-8110-d1a4c1150111";
const RUN_TWO = "019b793b-7b60-740e-8120-d1a4c1150112";
const PARTICIPANT = "019b793b-7b60-79a4-8110-cca0117a0410";

function event(
  overrides: Partial<ConsoleSessionEvent> & { readonly sequence: number },
): ConsoleSessionEvent {
  return {
    sessionId: SESSION_ID,
    kind: "run.running",
    occurredAt: `2026-01-01T11:0${String(overrides.sequence % 10)}:00.000Z`,
    ...overrides,
  };
}

function runEvent(sequence: number, runId: string, kind = "run.running"): ConsoleSessionEvent {
  return event({ sequence, kind, payload: { sessionId: SESSION_ID, runId } });
}

describe("the fixture shell's row projection", () => {
  it("produces rows the contract's own validator accepts", () => {
    const projection = projectFixtureShellRows([
      event({ sequence: 1, kind: "session.created", payload: { sessionId: SESSION_ID } }),
      runEvent(2, RUN_ONE),
    ]);

    expect(projection.rows).toHaveLength(2);
    for (const row of projection.rows) {
      // The real validator, not a shape check written here: a projection that
      // satisfied a local assertion and failed the contract would be a projection
      // the daemon's own consumers could never accept.
      expect(TimelineRowSchema.safeParse(row).success).toBe(true);
    }
  });

  it("files a run-attributed event on the run arm and an unattributed one on general", () => {
    const projection = projectFixtureShellRows([
      event({ sequence: 1, kind: "session.created", payload: { sessionId: SESSION_ID } }),
      runEvent(2, RUN_ONE),
    ]);

    const [sessionRow, runRow] = projection.rows;
    expect(sessionRow?.kind).toBe("general");
    expect(runRow?.kind).toBe("run");
    expect(runRow?.kind === "run" ? runRow.runId : undefined).toBe(RUN_ONE);
  });

  it("numbers positions within each run rather than across the log", () => {
    const projection = projectFixtureShellRows([
      runEvent(1, RUN_ONE),
      runEvent(2, RUN_TWO),
      runEvent(3, RUN_ONE),
    ]);

    const positions = projection.rows.map((row) => (row.kind === "run" ? row.position : -1));
    // Interleaved runs each keep their own count. A log-wide ordinal would read
    // [0, 1, 2] here, which is the defect this case exists to catch.
    expect(positions).toStrictEqual([0, 0, 1]);
  });

  it("advances a run's epoch past a rollback and leaves the boundary in the epoch it ended", () => {
    const projection = projectFixtureShellRows([
      runEvent(1, RUN_ONE),
      event({
        sequence: 2,
        kind: "run.rolled_back",
        actorParticipantId: PARTICIPANT,
        payload: { sessionId: SESSION_ID, runId: RUN_ONE, runVersion: 6, targetPosition: 0 },
      }),
      runEvent(3, RUN_ONE),
    ]);

    const epochs = projection.rows.map((row) =>
      row.kind === "run" || row.kind === "rollback_boundary" ? row.epoch : -1,
    );
    expect(epochs).toStrictEqual([0, 0, 1]);

    const boundary = projection.rows[1];
    expect(boundary?.kind).toBe("rollback_boundary");
    // The cutoff is the wire's own, never the shell's ordinal.
    expect(boundary?.kind === "rollback_boundary" ? boundary.position : undefined).toBe(0);
  });

  it("drops and counts an event the registered census carries no category for", () => {
    const projection = projectFixtureShellRows([
      runEvent(1, RUN_ONE),
      event({ sequence: 2, kind: "run.definitely_not_registered" }),
    ]);

    expect(projection.rows).toHaveLength(1);
    expect(projection.unprojectableEventCount).toBe(1);
  });

  it("drops and counts a rollback whose payload the contract refuses", () => {
    const projection = projectFixtureShellRows([
      event({
        sequence: 1,
        kind: "run.rolled_back",
        // `targetPosition` is missing, so the boundary's cutoff is unknowable.
        payload: { sessionId: SESSION_ID, runId: RUN_ONE, runVersion: 6 },
      }),
    ]);

    expect(projection.rows).toStrictEqual([]);
    expect(projection.unprojectableEventCount).toBe(1);
  });

  it("keys rows by the one identity the delivered envelope carries", () => {
    const projection = projectFixtureShellRows([runEvent(7, RUN_ONE), runEvent(8, RUN_ONE)]);

    const ids = projection.rows.map((row) => row.id);
    expect(ids).toStrictEqual([`${SESSION_ID}:7`, `${SESSION_ID}:8`]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("restates the wire type as the summary rather than composing a sentence", () => {
    // The negative control for this file's central claim: a projection that made a
    // sentence up would pass every other case here and fail this one. The contract
    // refuses an empty summary outright, so "say nothing" is not the alternative.
    const projection = projectFixtureShellRows([runEvent(1, RUN_ONE, "tool.invoked")]);
    expect(projection.rows[0]?.summary).toBe("tool.invoked");
    expect(projection.rows[0]?.summary).toBe(projection.rows[0]?.type);
  });

  it("projects an empty log into no rows and no drops", () => {
    expect(projectFixtureShellRows([])).toStrictEqual({ rows: [], unprojectableEventCount: 0 });
  });
});
