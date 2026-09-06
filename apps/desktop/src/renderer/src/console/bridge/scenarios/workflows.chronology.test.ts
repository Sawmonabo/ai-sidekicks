// A session exists before the things it owns, and the fixture is dated to that rule.
//
// A daemon cannot project a run, or a definition scoped to a session, that predates the
// session itself — so this suite reads the creation instant off the BEAT that creates
// it and holds every session-owned instant against it. Not a shape claim: every row
// here validates whatever it is dated, which is why the ordering needs a suite.

import { describe, expect, it } from "vitest";

import { compareInstants, parseInstant, type InstantReading } from "../../core/index.js";
import { WORKFLOWS_SCENARIO_DEFINITIONS } from "./workflow-fixture-definitions.js";
import { WORKFLOWS_SCENARIO_PHASE_OUTPUTS } from "./workflow-fixture-phase-outputs.js";
import { WORKFLOWS_SCENARIO_RUNS } from "./workflow-fixture-runs.js";
import { WORKFLOWS_SCENARIO } from "./workflows.js";

describe("the workflows scenario — the session exists before what it owns", () => {
  /**
   * The instant this session exists from, read off the beat that creates it.
   *
   * Off the BEAT rather than off `startedAtIso`, because the beat is the record a
   * daemon would have written and the start instant is only the frozen clock's
   * origin. The case below asserts the two agree, so the ordering rule is checked
   * against the event and not against the clock that happens to play it.
   */
  function sessionCreationInstant(): InstantReading {
    const created = WORKFLOWS_SCENARIO.beats.find((beat) => beat.event.kind === "session.created");
    if (created === undefined) {
      throw new Error("the scenario plays no `session.created` beat");
    }
    return parseInstant(created.event.occurredAt);
  }

  /**
   * Every instant carried by a record the SESSION owns, each labelled so a failure
   * names the row rather than a number.
   *
   * Three kinds and no others. A run belongs to the session it was started in; a
   * `session`-scoped definition was authored inside it; a phase output was produced
   * by one of its runs. A `project`- or `shared`-scoped definition is deliberately
   * absent — those belong to a repository root and to the daemon, neither of which
   * this session's creation bounds.
   */
  function sessionOwnedInstants(): readonly { readonly label: string; readonly instant: string }[] {
    return [
      ...WORKFLOWS_SCENARIO_RUNS.flatMap((run) => [
        { label: `run ${run.workflowRunId} started`, instant: run.startedAt },
        ...(run.endedAt === undefined
          ? []
          : [{ label: `run ${run.workflowRunId} ended`, instant: run.endedAt }]),
      ]),
      ...WORKFLOWS_SCENARIO_DEFINITIONS.filter((definition) => definition.scope === "session").map(
        (definition) => ({
          label: `session-scoped definition ${definition.name}`,
          instant: definition.createdAt,
        }),
      ),
      ...WORKFLOWS_SCENARIO_PHASE_OUTPUTS.map((output) => ({
        label: `phase output ${output.summary}`,
        instant: output.producedAt,
      })),
    ];
  }

  /**
   * Those of them a given creation instant would put in the impossible past.
   *
   * Ordered by the console's own comparator rather than by subtracting two host
   * parses, so an instant this console cannot read lands LAST and is never counted as
   * before anything. That is the honest disposition for this suite: an unreadable
   * fixture instant is a shape defect the wire-truth tier reports, and folding it in
   * here would let a fixture fail the ordering claim for a reason that is not about
   * order at all.
   */
  function recordsBefore(creation: InstantReading): readonly string[] {
    return sessionOwnedInstants()
      .filter(
        (record) => compareInstants(parseInstant(record.instant), creation, "oldest-first") < 0,
      )
      .map((record) => `${record.label} — ${record.instant}`);
  }

  it("plays the creation beat at the instant the frozen clock starts from", () => {
    // The two are one fact written twice, and a drift between them would make the
    // case below check the wrong instant while still passing.
    const creation = sessionCreationInstant();
    // Readable first, else the equality below would hold between two absent numbers
    // and say nothing at all about either instant.
    expect(creation.kind).toBe("instant");
    expect(creation.epochMilliseconds).toBe(
      parseInstant(WORKFLOWS_SCENARIO.startedAtIso).epochMilliseconds,
    );
  });

  it("dates every session-owned record at or after the session's own creation", () => {
    // A daemon cannot project a run, or a definition scoped to a session, that
    // predates the session itself. Printed rather than counted: a failure has to
    // name the record and the instant that made it impossible.
    expect(recordsBefore(sessionCreationInstant())).toStrictEqual([]);
  });

  it("negative control: the superseded creation instant puts session-owned records before it", () => {
    // The scenario used to open at 10:00 with its runs spread from 07:12 and its
    // session-scoped definition dated a fortnight earlier. Without this the case
    // above would hold over a helper that collected nothing at all.
    const supersededCreation = parseInstant("2026-01-01T10:00:00.000Z");
    const impossible = recordsBefore(supersededCreation);

    expect(impossible.length).toBeGreaterThan(0);
    expect(impossible.some((record) => record.startsWith("session-scoped definition"))).toBe(true);
    expect(impossible.some((record) => record.startsWith("run "))).toBe(true);
  });
});
