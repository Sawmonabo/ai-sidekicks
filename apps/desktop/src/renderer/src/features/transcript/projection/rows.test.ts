import { describe, expect, it } from "vitest";

// The row-id namespace comes from the transcript scenario that declares it: a stem
// restated here would be a second namespace the day the scenario's own moved.
import { EVENT_ID_STEM } from "#fixtures/scenarios/transcript-states.js";
import { isContractTranscriptEventRow } from "./rows.test-support.js";
import { type ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import { projectTranscriptRows } from "./rows.js";

const SESSION_ID = "019b793b-7b60-75e5-8510-ada11a5a44a5";
const RUN_ONE = "019b793b-7b60-740e-8110-d1a4c1150111";
const RUN_TWO = "019b793b-7b60-740e-8120-d1a4c1150112";
const USER = "019b793b-7b60-79a4-8110-cca0117a0410";

function event(
  overrides: Partial<ProjectedSessionEvent> & { readonly sequence: number },
): ProjectedSessionEvent {
  return {
    id: `${EVENT_ID_STEM}${String(overrides.sequence).padStart(4, "0")}`,
    sessionId: SESSION_ID,
    cursor: `cursor-at-${String(overrides.sequence)}`,
    kind: "run.running",
    occurredAt: `2026-01-01T11:0${String(overrides.sequence % 10)}:00.000Z`,
    ...overrides,
  };
}

/** An event of a run, stamped by the daemon at the turn position its sequence names. */
function runEvent(sequence: number, runId: string, kind = "run.running"): ProjectedSessionEvent {
  return event({
    sequence,
    kind,
    payload: { sessionId: SESSION_ID, runId },
    runStamp: { position: sequence, epoch: 0 },
  });
}

describe("the log-derived row projection", () => {
  it("produces rows the contract's own validator accepts", () => {
    const projection = projectTranscriptRows([
      event({ sequence: 1, kind: "session.created", payload: { sessionId: SESSION_ID } }),
      runEvent(2, RUN_ONE),
    ]);

    expect(projection.rows).toHaveLength(2);
    for (const row of projection.rows) {
      // The real contract validator, not a local shape check: a row it refuses is unusable
      // downstream.
      expect(isContractTranscriptEventRow(row)).toBe(true);
    }
  });

  it("files a run-attributed event on the run arm and an unattributed one on general", () => {
    const projection = projectTranscriptRows([
      event({ sequence: 1, kind: "session.created", payload: { sessionId: SESSION_ID } }),
      runEvent(2, RUN_ONE),
    ]);

    const [sessionRow, runRow] = projection.rows;
    expect(sessionRow?.kind).toBe("general");
    expect(runRow?.kind).toBe("run");
    expect(runRow?.kind === "run" ? runRow.runId : undefined).toBe(RUN_ONE);
  });

  it("draws nothing for an event type with no registered category", () => {
    const projection = projectTranscriptRows([
      runEvent(1, RUN_ONE),
      event({ sequence: 2, kind: "run.definitely_not_registered" }),
    ]);

    expect(projection.rows).toHaveLength(1);
  });

  it("draws nothing for a rollback whose payload the contract refuses", () => {
    const projection = projectTranscriptRows([
      event({
        sequence: 1,
        kind: "run.rolled_back",
        // `targetPosition` is missing, so the boundary's cutoff is unknowable.
        payload: { sessionId: SESSION_ID, runId: RUN_ONE, runVersion: 6 },
        runStamp: { position: 1, epoch: 0 },
      }),
    ]);

    expect(projection.rows).toStrictEqual([]);
  });

  it("keys rows by the event's own canonical id, wire-verbatim", () => {
    // The id is carried, not composed: the hydrated-event read is keyed `{sessionId, eventId}`
    // and a row jump finds a row by `TranscriptEventRow.id`, so a `session:sequence` key would
    // resolve for no caller.
    const events = [runEvent(7, RUN_ONE), runEvent(8, RUN_ONE)];
    const projection = projectTranscriptRows(events);

    const ids = projection.rows.map((row) => row.id);
    expect(ids).toStrictEqual(events.map((admitted) => admitted.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("restates the wire type as the summary rather than composing a sentence", () => {
    // Negative control for the central claim: a projection that made a sentence up would pass
    // every other case. The contract refuses an empty summary, so "say nothing" is no option.
    const projection = projectTranscriptRows([runEvent(1, RUN_ONE, "tool.invoked")]);
    expect(projection.rows[0]?.summary).toBe("tool.invoked");
    expect(projection.rows[0]?.summary).toBe(projection.rows[0]?.type);
  });
});

describe("which payload member names a row's run", () => {
  /** An intervention as the wire spells it: the run is `targetRunId`, never `runId`. */
  function interventionEvent(sequence: number, targetRunId: string): ProjectedSessionEvent {
    return event({
      sequence,
      kind: "intervention.applied",
      actorId: USER,
      payload: {
        sessionId: SESSION_ID,
        type: "interrupt",
        targetRunId,
        expectedRunVersion: 1,
        clientIdempotencyKey: `${EVENT_ID_STEM}0001`,
      },
      runStamp: { position: sequence, epoch: 0 },
    });
  }

  it("files an intervention under the run it names, beside that run's own rows", () => {
    // `intervention.*` spells the affected run `targetRunId`; it must not project as a
    // session-level row outside its run group.
    const projection = projectTranscriptRows([
      runEvent(1, RUN_ONE),
      interventionEvent(2, RUN_ONE),
      runEvent(3, RUN_ONE, "run.completed"),
    ]);

    expect(projection.rows.map((row) => row.kind)).toStrictEqual(["run", "run", "run"]);
    expect(
      projection.rows.map((row) => (row.kind === "run" ? row.runId : undefined)),
    ).toStrictEqual([RUN_ONE, RUN_ONE, RUN_ONE]);
  });

  it("attributes a child run to itself and never to the parent it names", () => {
    // `run.queued` carries `parentRunId` beside its own `runId`; reading any run-naming member
    // would file the child's rows in the parent's group. The contract's attributing list, which
    // omits that spelling, is what keeps it out at runtime.
    const projection = projectTranscriptRows([
      event({
        sequence: 1,
        kind: "run.queued",
        payload: { sessionId: SESSION_ID, runId: RUN_TWO, parentRunId: RUN_ONE },
        runStamp: { position: 0, epoch: 0 },
      }),
    ]);

    const [row] = projection.rows;
    expect(row?.kind).toBe("run");
    expect(row?.kind === "run" ? row.runId : undefined).toBe(RUN_TWO);
  });
});
