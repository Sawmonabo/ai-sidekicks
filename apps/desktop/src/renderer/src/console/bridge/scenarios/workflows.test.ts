// Does the workflows scenario tell the story it claims, in a shape the wire admits?
//
// Two different questions, and this file keeps them apart. The first is whether the
// beats are events a daemon could emit, and that is answered by driving the SHIPPED
// predicate — `findScenarioWireTruthDefects` — rather than by restating its rules
// here; a local copy would go green against a rule nobody ships. The second is
// whether the fixture data actually carries the four distinct runs the surfaces need,
// which no predicate can answer because it is a claim about content rather than shape.
//
// The reply cases drive `settleScriptedReply` — the one seam a served growth
// operation answers a workflow read through — rather than reading `scenario.replies`
// directly. Reading the array would assert that a literal is present; driving the seam
// asserts that a caller asking for that call gets it, which is the property the panes
// depend on and the only one that can break.

import { describe, expect, it } from "vitest";

import {
  WORKFLOWS_COMPLETED_PHASE_ID,
  WORKFLOWS_PARKED_RUN,
  WORKFLOWS_SCENARIO_DEFINITIONS,
  WORKFLOWS_SCENARIO_PHASE_OUTPUTS,
  WORKFLOWS_SCENARIO_RUNS,
} from "./workflow-fixture-data.js";
import { WORKFLOWS_SCENARIO } from "./workflows.js";
import { findScenarioWireTruthDefects } from "./wire-truth.js";
import { ScenarioEngine } from "../scenario-engine.js";
import type { ConsoleScenario } from "../scenario.js";
import { settleScriptedReply } from "../scripted-reply.js";
import type {
  WorkflowPhaseState,
  WorkflowRunListEntry,
  WorkflowRunSnapshot,
} from "../workflow-projection.js";

/**
 * The definition facts the enumeration pairs with each run, one constant per
 * definition rather than one per run — because two of the four runs came from the
 * same definition and writing that pairing twice is how a fixture assertion comes to
 * disagree with the fixture.
 */
const RELEASE_CHECKS_DEFINITION_FACTS = {
  definitionName: "Release checks",
  definitionLatestWorkflowVersionId: "019b7a10-0280-7d22-8100-be5100150004",
} as const;

const SHIP_PIPELINE_DEFINITION_FACTS = {
  definitionName: "Ship pipeline",
  definitionLatestWorkflowVersionId: "019b7a10-0280-7d22-8100-be5100150003",
} as const;

const INCIDENT_TRIAGE_DEFINITION_FACTS = {
  definitionName: "Incident triage",
  definitionLatestWorkflowVersionId: "019b7a10-0280-7d22-8100-be5100150002",
} as const;

/** The enumeration's entries, settled and narrowed, for the cases that read them. */
async function enumerationEntries(
  engine: ScenarioEngine,
): Promise<readonly WorkflowRunListEntry[]> {
  const runList = await settleScriptedReply(engine, "workflow.runList");
  if (runList.status !== "resolved") {
    throw new Error(`the enumeration settled ${runList.status}`);
  }
  return (runList.value as { readonly runs: readonly WorkflowRunListEntry[] }).runs;
}

/** Every phase across every run, so a claim about parks can be made over all of them. */
function everyPhase(): readonly WorkflowPhaseState[] {
  return WORKFLOWS_SCENARIO_RUNS.flatMap((run) => run.phaseStates);
}

/** The phases of one run that are parked right now, read through the wire's own discriminator. */
function parkedPhasesOf(run: WorkflowRunSnapshot): readonly WorkflowPhaseState[] {
  return run.phaseStates.filter((phase) => phase.parkReason !== undefined);
}

/** The one run in a given state, asserted to be the only one so a case cannot pass on a neighbour. */
function soleRunInState(state: WorkflowRunSnapshot["state"]): WorkflowRunSnapshot {
  const matches = WORKFLOWS_SCENARIO_RUNS.filter((run) => run.state === state);
  expect(matches).toHaveLength(1);
  const [only] = matches;
  if (only === undefined) {
    throw new Error(`no run in state ${state}`);
  }
  return only;
}

describe("the workflows scenario — wire truth", () => {
  it("plays only registered event types, with the payloads those types register", () => {
    const defects = findScenarioWireTruthDefects([WORKFLOWS_SCENARIO]);

    // Printed rather than counted: a failure here has to name the beat and the reason.
    expect(defects.map((defect) => `${defect.subject} — ${defect.reason}`)).toStrictEqual([]);
  });

  it("reports a defect when a beat of this scenario is perturbed", () => {
    // The negative control for the case above. Without it that assertion would pass
    // against a predicate that never looked at this scenario at all.
    const [firstBeat, ...remainingBeats] = WORKFLOWS_SCENARIO.beats;
    if (firstBeat === undefined) {
      throw new Error("the scenario plays no beats");
    }
    const perturbed: ConsoleScenario = {
      ...WORKFLOWS_SCENARIO,
      beats: [
        { ...firstBeat, event: { ...firstBeat.event, kind: "workflow.phase_suspended" } },
        ...remainingBeats,
      ],
    };

    const defects = findScenarioWireTruthDefects([perturbed]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.reason).toContain("not a registered event type");
  });

  it("states a viewer the session's own roster carries", () => {
    // The identity the fixture answers the caller-identity read from. Asserted here as
    // well as by the predicate because its absence is silent: every role gate would
    // read unchecked, which looks exactly like a member with no elevated role.
    expect(WORKFLOWS_SCENARIO.viewingParticipantId).toBeDefined();
    expect(WORKFLOWS_SCENARIO.participantIdsInJoinOrder).toContain(
      WORKFLOWS_SCENARIO.viewingParticipantId,
    );
  });
});

describe("the workflows scenario — what a caller is answered with", () => {
  it("answers the four workflow reads through the scripted-reply seam", async () => {
    const engine = new ScenarioEngine({ scenario: WORKFLOWS_SCENARIO });

    const definitionList = await settleScriptedReply(engine, "workflow.definitionList");
    const runList = await settleScriptedReply(engine, "workflow.runList");
    const runRead = await settleScriptedReply(engine, "workflow.runRead");
    const phaseOutputRead = await settleScriptedReply(engine, "workflow.phaseOutputRead");

    expect(definitionList).toStrictEqual({
      status: "resolved",
      value: { definitions: WORKFLOWS_SCENARIO_DEFINITIONS },
    });
    // Every run in the table, unsorted: the attention ordering is the console's fold
    // and a reply that pre-sorted them would hide a fold that had stopped working.
    // Each row widened by exactly the two definition facts the ENUMERATION carries
    // and the run read does not — the run's own members are untouched, which is what
    // `enumerationEntries` below asserts member by member.
    expect(runList).toStrictEqual({
      status: "resolved",
      value: {
        runs: [
          { ...WORKFLOWS_SCENARIO_RUNS[0], ...RELEASE_CHECKS_DEFINITION_FACTS },
          { ...WORKFLOWS_PARKED_RUN, ...SHIP_PIPELINE_DEFINITION_FACTS },
          { ...WORKFLOWS_SCENARIO_RUNS[2], ...INCIDENT_TRIAGE_DEFINITION_FACTS },
          { ...WORKFLOWS_SCENARIO_RUNS[3], ...SHIP_PIPELINE_DEFINITION_FACTS },
        ],
      },
    });
    expect(runRead).toStrictEqual({ status: "resolved", value: WORKFLOWS_PARKED_RUN });
    expect(phaseOutputRead).toStrictEqual({
      status: "resolved",
      value: {
        phaseId: WORKFLOWS_COMPLETED_PHASE_ID,
        state: "completed",
        outputs: WORKFLOWS_SCENARIO_PHASE_OUTPUTS,
      },
    });
    engine.dispose();
  });

  it("scripts no mutating workflow call", async () => {
    // The negative control for the case above, and a rule in its own right: a scripted
    // answer is a fixed value rather than a state machine, so a cancel that "succeeded"
    // would sit beside a run read still answering `suspended`.
    const engine = new ScenarioEngine({ scenario: WORKFLOWS_SCENARIO });

    for (const call of [
      "workflow.runCancel",
      "workflow.runResume",
      "workflow.gateResolve",
      "workflow.humanFormSubmit",
      "workflow.runStart",
    ]) {
      expect(await settleScriptedReply(engine, call)).toStrictEqual({ status: "unscripted" });
    }
    engine.dispose();
  });

  it("answers the run read with a run the list also carries", async () => {
    // The pane's run and the list's run are one object, not two literals that agree
    // today. Identity rather than deep equality, because deep equality would still pass
    // for two copies that a later edit could take apart.
    const engine = new ScenarioEngine({ scenario: WORKFLOWS_SCENARIO });

    const runRead = await settleScriptedReply(engine, "workflow.runRead");

    expect(runRead.status).toBe("resolved");
    expect(WORKFLOWS_SCENARIO_RUNS).toContain(WORKFLOWS_PARKED_RUN);
    engine.dispose();
  });

  it("answers the enumeration with the pane's own run, widened and not rebuilt", async () => {
    // The same claim one seam further out, restated for a reply that must ADD two
    // members: an entry cannot be the run object itself any more, so what is asserted
    // is that it is that object spread — every run member equal, and the phase
    // collection the SAME array, which a rebuilt table could not produce.
    const engine = new ScenarioEngine({ scenario: WORKFLOWS_SCENARIO });

    const enumerated = await enumerationEntries(engine);
    const parked = enumerated.find(
      (entry) => entry.workflowRunId === WORKFLOWS_PARKED_RUN.workflowRunId,
    );

    expect(enumerated).toHaveLength(4);
    expect(parked).toStrictEqual({ ...WORKFLOWS_PARKED_RUN, ...SHIP_PIPELINE_DEFINITION_FACTS });
    expect(parked?.phaseStates).toBe(WORKFLOWS_PARKED_RUN.phaseStates);
    engine.dispose();
  });

  it("names a definition for every run, including the one pinned behind its latest", async () => {
    // The frozen pin is the case no derivation can recover: its version is nobody's
    // latest, so a fixture that paired runs by matching the definition table would
    // leave exactly the run the label exists for without a definition at all.
    const engine = new ScenarioEngine({ scenario: WORKFLOWS_SCENARIO });

    const enumerated = await enumerationEntries(engine);
    const frozen = enumerated.filter(
      (entry) => entry.definitionLatestWorkflowVersionId !== entry.workflowVersionId,
    );

    expect(enumerated.every((entry) => entry.definitionName.length > 0)).toBe(true);
    expect(frozen).toHaveLength(1);
    expect(frozen[0]?.definitionName).toBe("Ship pipeline");
    engine.dispose();
  });
});

describe("the workflows scenario — the four runs", () => {
  it("carries one run in each of the four states the surfaces render", () => {
    expect(WORKFLOWS_SCENARIO_RUNS).toHaveLength(4);
    expect(soleRunInState("running").phaseStates.some((phase) => phase.state === "running")).toBe(
      true,
    );
    expect(soleRunInState("cancelled")).toBeDefined();
    // Two runs are suspended — the parked one and the frozen-pin one — which is what
    // gives the attention fold something to fold.
    expect(WORKFLOWS_SCENARIO_RUNS.filter((run) => run.state === "suspended")).toHaveLength(2);
  });

  it("parks nothing on the working run and nothing on the cancelled one", () => {
    // The live-scoping rule, asserted where it is easiest to violate: a settled run
    // that kept a stale park member would render as still waiting forever.
    expect(parkedPhasesOf(soleRunInState("running"))).toStrictEqual([]);
    expect(parkedPhasesOf(soleRunInState("cancelled"))).toStrictEqual([]);
  });

  it("carries both park reasons, and arms a resume on exactly one of them", () => {
    const parked = everyPhase().filter((phase) => phase.parkReason !== undefined);
    const armed = parked.filter((phase) => phase.autoResumeAt !== undefined);
    const humanParks = parked.filter((phase) => phase.parkReason === "waiting-human");

    expect(parked).toHaveLength(3);
    expect(armed).toHaveLength(1);
    expect(humanParks).toHaveLength(1);
    // The unscheduled usage-limit park is the third: a park a banner must read as
    // awaiting resume rather than as scheduled. Without it the fixture could only ever
    // drive the countdown arm.
    expect(
      parked.filter(
        (phase) =>
          phase.parkReason === "provider-usage-limited" && phase.autoResumeAt === undefined,
      ),
    ).toHaveLength(1);
  });

  it("gives every parked phase the cause its reason obliges", () => {
    // `parkCause` is present whenever `parkReason` is, by the producer's own rule. A
    // reason with no cause would render a park with an empty sentence, which reads as
    // an engine that had no reason rather than as a malformed response.
    for (const phase of everyPhase()) {
      expect(phase.parkCause === undefined).toBe(phase.parkReason === undefined);
    }
  });

  it("arms the attention key only where the resume instant is armed beside it", () => {
    // The registered shape gives `parkAttentionKey` the same presence rule as
    // `autoResumeAt`: both are armed by the park and cleared on exit, so a row
    // carrying one without the other is a response no daemon has the state to build.
    // The suite above checks `parkCause` against `parkReason` and checked this pair
    // nowhere — the presence rules were transcribed one member at a time, and a rule
    // that binds TWO members has no home in a per-member loop. That is how a fixture
    // row carrying the key with no instant validated, folded, and screenshotted.
    for (const phase of everyPhase()) {
      expect(phase.parkAttentionKey === undefined, phase.phaseId).toBe(
        phase.autoResumeAt === undefined,
      );
    }
  });

  it("negative control: one park arms both members, so the pair rule is not vacuous", () => {
    // Without this, a table that armed no park anywhere would satisfy the rule above
    // by holding neither member at all — and the countdown arm would have no subject.
    const armed = everyPhase().filter((phase) => phase.autoResumeAt !== undefined);

    expect(armed).toHaveLength(1);
    expect(armed[0]?.parkAttentionKey).toBeDefined();
  });

  it("carries the cancellation reason where the contract puts it", () => {
    const cancelled = soleRunInState("cancelled");

    expect(cancelled.failureReason).toBeDefined();
    expect(cancelled.endedAt).toBeDefined();
    // Completed phase outputs stay addressable on a run that will not move again.
    expect(cancelled.phaseStates.some((phase) => phase.state === "completed")).toBe(true);
  });

  it("pins exactly one run behind its definition's latest version", () => {
    const latestVersionIds = new Set(
      WORKFLOWS_SCENARIO_DEFINITIONS.map((definition) => definition.latestWorkflowVersionId),
    );
    const behind = WORKFLOWS_SCENARIO_RUNS.filter(
      (run) => !latestVersionIds.has(run.workflowVersionId),
    );

    expect(behind).toHaveLength(1);
    // The other arm, so the case above is an inequality rather than a table where no
    // run's pin ever matches a definition at all.
    expect(WORKFLOWS_SCENARIO_RUNS.length - behind.length).toBe(3);
  });
});

describe("the workflows scenario — the definitions", () => {
  it("marks exactly one resolving row per definition name", () => {
    const resolvingByName = new Map<string, number>();
    for (const definition of WORKFLOWS_SCENARIO_DEFINITIONS) {
      if (definition.resolvesAtThisContext) {
        resolvingByName.set(definition.name, (resolvingByName.get(definition.name) ?? 0) + 1);
      }
    }
    const names = new Set(WORKFLOWS_SCENARIO_DEFINITIONS.map((definition) => definition.name));

    expect([...resolvingByName.values()]).toStrictEqual(Array.from(names, () => 1));
  });

  it("carries a name at more than one scope, so the resolution mark says something", () => {
    // Without a repeated name every row would resolve and the flag would be a constant.
    const countsByName = new Map<string, number>();
    for (const definition of WORKFLOWS_SCENARIO_DEFINITIONS) {
      countsByName.set(definition.name, (countsByName.get(definition.name) ?? 0) + 1);
    }

    expect([...countsByName.values()].filter((count) => count > 1).length).toBeGreaterThan(0);
  });

  it("populates all three scopes and gives each its own scope identity", () => {
    const scopes = new Set(WORKFLOWS_SCENARIO_DEFINITIONS.map((definition) => definition.scope));

    expect(scopes).toStrictEqual(new Set(["session", "project", "shared"]));
    for (const definition of WORKFLOWS_SCENARIO_DEFINITIONS) {
      // `shared` is daemon-wide and refers to nothing narrower, so its reference is
      // empty by the contract rather than by omission; the other two name something.
      expect(definition.scopeRef === "").toBe(definition.scope === "shared");
      expect(definition.contentHash.startsWith("b3:")).toBe(true);
    }
  });
});

describe("the workflows scenario — the phase outputs", () => {
  it("carries both output value kinds", () => {
    const kinds = WORKFLOWS_SCENARIO_PHASE_OUTPUTS.map((output) => output.valueKind);

    expect(new Set(kinds)).toStrictEqual(new Set(["inline", "artifact_ref"]));
    for (const output of WORKFLOWS_SCENARIO_PHASE_OUTPUTS) {
      // An artifact reference carries its id; an inline output must not, or the older
      // daemon's fallback reading would classify it as a reference.
      expect(output.artifactId !== undefined).toBe(output.valueKind === "artifact_ref");
    }
  });
});

describe("the workflows scenario — the session exists before what it owns", () => {
  /**
   * The instant this session exists from, read off the beat that creates it.
   *
   * Off the BEAT rather than off `startedAtIso`, because the beat is the record a
   * daemon would have written and the start instant is only the frozen clock's
   * origin. The case below asserts the two agree, so the ordering rule is checked
   * against the event and not against the clock that happens to play it.
   */
  function sessionCreationInstant(): number {
    const created = WORKFLOWS_SCENARIO.beats.find((beat) => beat.event.kind === "session.created");
    if (created === undefined) {
      throw new Error("the scenario plays no `session.created` beat");
    }
    return Date.parse(created.event.occurredAt);
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

  /** Those of them a given creation instant would put in the impossible past. */
  function recordsBefore(creationInstant: number): readonly string[] {
    return sessionOwnedInstants()
      .filter((record) => Date.parse(record.instant) < creationInstant)
      .map((record) => `${record.label} — ${record.instant}`);
  }

  it("plays the creation beat at the instant the frozen clock starts from", () => {
    // The two are one fact written twice, and a drift between them would make the
    // case below check the wrong instant while still passing.
    expect(sessionCreationInstant()).toBe(Date.parse(WORKFLOWS_SCENARIO.startedAtIso));
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
    const supersededCreation = Date.parse("2026-01-01T10:00:00.000Z");
    const impossible = recordsBefore(supersededCreation);

    expect(impossible.length).toBeGreaterThan(0);
    expect(impossible.some((record) => record.startsWith("session-scoped definition"))).toBe(true);
    expect(impossible.some((record) => record.startsWith("run "))).toBe(true);
  });
});
