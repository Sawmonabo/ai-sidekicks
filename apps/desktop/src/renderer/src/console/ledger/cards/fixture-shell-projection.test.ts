import { describe, expect, it } from "vitest";

import { TIMELINE_RUN_ATTRIBUTION_PAYLOAD_KEYS, TimelineRowSchema } from "@ai-sidekicks/contracts";

import { type ConsoleSessionEvent } from "../../store/index.js";
import { deriveSupersededBands } from "../structure/index.js";
import {
  projectFixtureShellRows,
  RUN_ATTRIBUTION_BY_PAYLOAD_MEMBER,
  type RunAttributionRole,
  type RunNamingPayloadMember,
} from "./fixture-shell-projection.js";

/**
 * The compile-time control for the run-attribution table.
 *
 * The table's live effect is TOTALITY over every run-naming member of the payloads
 * the shell reads: one that grows such a member does not compile until the table
 * says which run it names. A table missing `parentRunId` is not total, and the
 * directive below asserts exactly that — loosen the table's type and the suppressed
 * error stops occurring, which makes the directive itself the error. The claim
 * cannot rot quietly in either direction.
 */
// @ts-expect-error — deliberately missing `parentRunId`; totality is the property.
const TABLE_THE_COMPILER_REJECTS: Readonly<Record<RunNamingPayloadMember, RunAttributionRole>> = {
  runId: "this-run",
  targetRunId: "this-run",
};

/** The decisions, read by a member the contract spells as a free-form string. */
const ROLE_BY_MEMBER: Readonly<Record<string, RunAttributionRole>> =
  RUN_ATTRIBUTION_BY_PAYLOAD_MEMBER;

const SESSION_ID = "019b793b-7b60-75e5-8510-ada11a5a44a5";
const RUN_ONE = "019b793b-7b60-740e-8110-d1a4c1150111";
const RUN_TWO = "019b793b-7b60-740e-8120-d1a4c1150112";
const PARTICIPANT = "019b793b-7b60-79a4-8110-cca0117a0410";

function event(
  overrides: Partial<ConsoleSessionEvent> & { readonly sequence: number },
): ConsoleSessionEvent {
  return {
    id: `019b793b-7b60-7ea1-8110-e5e0d115${String(overrides.sequence).padStart(4, "0")}`,
    sessionId: SESSION_ID,
    kind: "run.running",
    occurredAt: `2026-01-01T11:0${String(overrides.sequence % 10)}:00.000Z`,
    ...overrides,
  };
}

function runEvent(sequence: number, runId: string, kind = "run.running"): ConsoleSessionEvent {
  return event({ sequence, kind, payload: { sessionId: SESSION_ID, runId } });
}

function rollbackEvent(
  sequence: number,
  runId: string,
  targetPosition: number,
): ConsoleSessionEvent {
  return event({
    sequence,
    kind: "run.rolled_back",
    actorId: PARTICIPANT,
    payload: { sessionId: SESSION_ID, runId, runVersion: sequence, targetPosition },
  });
}

/** Every run row's `(position, epoch)`, in log order. Boundaries and general rows omitted. */
function runOrdinals(
  rows: ReturnType<typeof projectFixtureShellRows>["rows"],
): readonly (readonly [number, number])[] {
  return rows.flatMap((row) => (row.kind === "run" ? [[row.position, row.epoch] as const] : []));
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
        actorId: PARTICIPANT,
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

describe("counting through a rewind", () => {
  it("returns the count to the anchor the rollback landed on", () => {
    const projection = projectFixtureShellRows([
      runEvent(1, RUN_ONE),
      runEvent(2, RUN_ONE),
      runEvent(3, RUN_ONE),
      runEvent(4, RUN_ONE),
      runEvent(5, RUN_ONE),
      rollbackEvent(6, RUN_ONE, 3),
      runEvent(7, RUN_ONE),
      runEvent(8, RUN_ONE),
    ]);

    // Five rows at 0–4 in epoch 0, then the rewind, then the re-execution counting
    // from the anchor again — in the epoch the rewind opened.
    expect(runOrdinals(projection.rows)).toStrictEqual([
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
      [4, 0],
      [3, 1],
      [4, 1],
    ]);
  });

  it("bands a second rewind over its own epoch's rows and no others", () => {
    // The consequence the ordinals exist for. A count that ran on through the first
    // rewind would put the new epoch's rows at 5 and 6, and this second rewind — to
    // the same anchor — would find BOTH of them above its cutoff and dim a whole
    // re-execution that nothing rewound past.
    const projection = projectFixtureShellRows([
      runEvent(1, RUN_ONE),
      runEvent(2, RUN_ONE),
      runEvent(3, RUN_ONE),
      runEvent(4, RUN_ONE),
      runEvent(5, RUN_ONE),
      rollbackEvent(6, RUN_ONE, 3),
      runEvent(7, RUN_ONE),
      runEvent(8, RUN_ONE),
      rollbackEvent(9, RUN_ONE, 3),
    ]);

    const secondEpochBands = deriveSupersededBands(projection.rows).filter(
      (band) => band.epoch === 1,
    );
    expect(secondEpochBands).toHaveLength(1);
    expect(secondEpochBands[0]?.rowIds).toStrictEqual([`${SESSION_ID}:8`]);
  });

  it("negative control: a rewind in one run leaves another run's count alone", () => {
    // Without this, a fix that reset a shared counter rather than the rewound run's
    // own would pass both cases above and renumber every other run in the window.
    const projection = projectFixtureShellRows([
      runEvent(1, RUN_ONE),
      runEvent(2, RUN_TWO),
      runEvent(3, RUN_TWO),
      rollbackEvent(4, RUN_ONE, 0),
      runEvent(5, RUN_TWO),
    ]);

    const secondRunOrdinals = projection.rows.flatMap((row) =>
      row.kind === "run" && row.runId === RUN_TWO ? [[row.position, row.epoch] as const] : [],
    );
    expect(secondRunOrdinals).toStrictEqual([
      [0, 0],
      [1, 0],
      [2, 0],
    ]);
  });
});

describe("the run-attribution table — a compile gate, and a dormant runtime arm", () => {
  it("decides every key the contract lists, so the runtime filter removes nothing", () => {
    // The dormancy, checked rather than claimed. `parentRunId` is decided
    // `another-run` and the contract's list does not carry it, so the intersection
    // in `runIdOf` drops no member at today's contract; it is the fail-closed arm
    // for a list that grows a key nobody here has reviewed.
    for (const attributingKey of TIMELINE_RUN_ATTRIBUTION_PAYLOAD_KEYS) {
      expect(ROLE_BY_MEMBER[attributingKey], attributingKey).toBe("this-run");
    }
    const decidedElsewhere = Object.entries(RUN_ATTRIBUTION_BY_PAYLOAD_MEMBER)
      .filter(([, role]) => role === "another-run")
      .map(([member]) => member);
    expect(decidedElsewhere).toStrictEqual(["parentRunId"]);
    for (const member of decidedElsewhere) {
      expect(TIMELINE_RUN_ATTRIBUTION_PAYLOAD_KEYS, member).not.toContain(member);
    }
  });

  it("negative control: the table the compiler rejects is short at runtime too", () => {
    // The `@ts-expect-error` above is the real guard; this reads the same object
    // back so the suppressed line is not a comment nobody executes.
    expect(Object.keys(TABLE_THE_COMPILER_REJECTS)).not.toContain("parentRunId");
  });
});

describe("which payload member names a row's run", () => {
  /** An intervention as the wire spells it: the run is `targetRunId`, never `runId`. */
  function interventionEvent(sequence: number, targetRunId: string): ConsoleSessionEvent {
    return event({
      sequence,
      kind: "intervention.applied",
      actorId: PARTICIPANT,
      payload: {
        sessionId: SESSION_ID,
        type: "interrupt",
        targetRunId,
        expectedRunVersion: 1,
        clientIdempotencyKey: "019b793b-7b60-7ea1-8110-e5e0d1150001",
      },
    });
  }

  it("files an intervention under the run it names, beside that run's own rows", () => {
    // The defect: `intervention.*` spells the affected run `targetRunId`, so every
    // one of them projected as a session-level row and sat outside the run chapter
    // it belongs to — on a ledger whose whole shape is runs.
    const projection = projectFixtureShellRows([
      runEvent(1, RUN_ONE),
      interventionEvent(2, RUN_ONE),
      runEvent(3, RUN_ONE, "run.completed"),
    ]);

    expect(projection.rows.map((row) => row.kind)).toStrictEqual(["run", "run", "run"]);
    expect(
      projection.rows.map((row) => (row.kind === "run" ? row.runId : undefined)),
    ).toStrictEqual([RUN_ONE, RUN_ONE, RUN_ONE]);
    // And it takes its ordinal in that run's own sequence rather than sitting
    // outside the counting: chapters fold on this number and the rail lays its
    // marks along it.
    expect(runOrdinals(projection.rows)).toStrictEqual([
      [0, 0],
      [1, 0],
      [2, 0],
    ]);
  });

  it("leaves every other run-keyed kind exactly where it was", () => {
    const projection = projectFixtureShellRows([
      runEvent(1, RUN_ONE),
      runEvent(2, RUN_TWO),
      rollbackEvent(3, RUN_ONE, 0),
      runEvent(4, RUN_ONE),
    ]);

    expect(projection.rows.map((row) => row.kind)).toStrictEqual([
      "run",
      "run",
      "rollback_boundary",
      "run",
    ]);
    expect(projection.unprojectableEventCount).toBe(0);
  });

  it("attributes a child run to itself and never to the parent it names", () => {
    // `run.queued` carries `parentRunId` beside its own `runId`. Reading any
    // run-naming member would file the child's rows in the parent's chapter, which
    // is the same defect in the other direction. What keeps it out here is the
    // CONTRACT's attributing list, which does not carry that spelling; the local
    // table's own job is the compile gate the group above drives.
    const projection = projectFixtureShellRows([
      event({
        sequence: 1,
        kind: "run.queued",
        payload: { sessionId: SESSION_ID, runId: RUN_TWO, parentRunId: RUN_ONE },
      }),
    ]);

    const [row] = projection.rows;
    expect(row?.kind).toBe("run");
    expect(row?.kind === "run" ? row.runId : undefined).toBe(RUN_TWO);
  });

  it("negative control: an event naming no run at all stays a session row", () => {
    // Without this the lookup could answer with any string it found, which would
    // file session rows under whatever the payload happened to carry.
    const projection = projectFixtureShellRows([
      event({
        sequence: 1,
        kind: "session.renamed",
        payload: { sessionId: SESSION_ID, name: "a session, renamed" },
      }),
    ]);

    expect(projection.rows.map((row) => row.kind)).toStrictEqual(["general"]);
  });
});
