// The reply legs: one answer per call, and a latency the frozen clock can spend.
//
// Beside the aggregate entry with its sibling axis files, and every case drives
// `findScenarioWireTruthDefects` rather than the leg module — the aggregate is the
// only surface a family's scenario is ever measured through.
//
// EVERY CASE IS BUILT FROM THE SHIPPED SEAT BOARD. The flagship's own replies are
// the base, so what a case varies is the one property it is about; its beats are
// the beats every other leg already accepts, which is what keeps a reported defect
// attributable to the reply and not to the script around it.

import { describe, expect, it } from "vitest";

import { FLAGSHIP_SCENARIO } from "./flagship.js";
import { findScenarioWireTruthDefects } from "./wire-truth.js";
import type { ConsoleScenario, ScenarioReply } from "../scenario.js";

/** A call the flagship scripts no answer for, so a case adds one rather than shadowing one. */
const PROBE_CALL = "run.queueList";

/** The flagship, with one extra reply carrying the latency under test. */
function scenarioWithProbeReply(scenarioId: string, afterMs: number): ConsoleScenario {
  const probeReply: ScenarioReply = { call: PROBE_CALL, afterMs, result: { items: [] } };
  return {
    ...FLAGSHIP_SCENARIO,
    id: scenarioId,
    replies: [...FLAGSHIP_SCENARIO.replies, probeReply],
  };
}

describe("scenario wire truth — a call the corpus registers nowhere", () => {
  /** The flagship, with one extra reply answering `call`. */
  const scenarioAnswering = (call: string): ConsoleScenario => ({
    ...FLAGSHIP_SCENARIO,
    id: "answers-a-call",
    replies: [...FLAGSHIP_SCENARIO.replies, { call, result: {} }],
  });

  it("reports a scripted reply to a method nothing registers", () => {
    // The defect this leg was written for, and it is not hypothetical: a scenario
    // answering `workflow.runList` renders a surface that looks served, ships a
    // reference image of it, and reaches nothing on the day the fixture define flips.
    // The slate registers `workflow.runRead` and `workflow.definitionList`, which is
    // exactly what makes the invented name read like a real one.
    const defects = findScenarioWireTruthDefects([scenarioAnswering("workflow.runList")]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.subject).toBe('reply "workflow.runList"');
    expect(defects[0]?.reason).toContain("registers nowhere");
  });

  it("passes a registered daemon method and a growth row's expected wire method", () => {
    // Both admitted classes, so the claim above is a finding about the call rather
    // than about which registry a reader happened to check. Both probes are also
    // REACHABLE — a bound method and a served growth operation — because the walk's
    // other reachability leg reports a scripted answer to an operation the fixture
    // port refuses, and a probe that tripped it would report this case's own claim
    // as a defect about something else entirely.
    expect(findScenarioWireTruthDefects([scenarioAnswering("run.queueList")])).toStrictEqual([]);
    expect(
      findScenarioWireTruthDefects([scenarioAnswering("approval.projectionRead")]),
    ).toStrictEqual([]);
  });

  it("passes an operation-id key only where the growth row registers no wire method", () => {
    // The one shape that is manifestly not a method string, and it is admitted for a
    // growth row that has no name to transcribe. A row that DOES declare one is
    // scripted under that name, because the live transport sends that name.
    expect(findScenarioWireTruthDefects([scenarioAnswering("growth:callerParticipantRead")])) //
      .toStrictEqual([]);

    const wrongKey = findScenarioWireTruthDefects([scenarioAnswering("growth:sessionRead")]);
    expect(wrongKey).toHaveLength(1);
    expect(wrongKey[0]?.reason).toContain("session.read");

    const unknownId = findScenarioWireTruthDefects([scenarioAnswering("growth:notAnOperation")]);
    expect(unknownId).toHaveLength(1);
    expect(unknownId[0]?.reason).toContain("registers no operation by that id");
  });

  it("negative control: the shipped seat board answers only registered calls", () => {
    // The real tree, which is where a family's invented name would land. Every call it
    // scripts is admitted by a derived registry rather than by a transcription: the
    // daemon binding table, or a growth row's own expected wire method, which is what
    // admits `agent.list`.
    expect(findScenarioWireTruthDefects([FLAGSHIP_SCENARIO])).toStrictEqual([]);
  });
});

describe("scenario wire truth — a scripted latency the frozen clock cannot spend", () => {
  it("reports a latency of Infinity, which parks the reply past every finite advance", () => {
    // The engine parks a delayed reply at `elapsedMs + afterMs` and releases it when
    // an advance reaches that tick. No advance reaches this one, so the reply is
    // settled only by teardown — as abandoned — and the surface awaiting it renders
    // its loading state for the life of the window.
    const defects = findScenarioWireTruthDefects([
      scenarioWithProbeReply("parks-forever", Number.POSITIVE_INFINITY),
    ]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.subject).toBe(`reply "${PROBE_CALL}"`);
    expect(defects[0]?.reason).toContain("Infinity");
    expect(defects[0]?.reason).toContain("loading state");
  });

  it("reports a latency of NaN, which the engine's own test refuses and never parks", () => {
    // The opposite failure with the same symptom on the gate: the fixture spends a
    // latency only above zero, and `NaN` is not, so the reply settles on the calling
    // turn and the loading state the scenario claims to exercise is unreachable.
    const defects = findScenarioWireTruthDefects([
      scenarioWithProbeReply("never-parks", Number.NaN),
    ]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.subject).toBe(`reply "${PROBE_CALL}"`);
    expect(defects[0]?.reason).toContain("NaN");
    expect(defects[0]?.reason).toContain("settles on the calling turn");
  });

  it("reports a negative latency, which settles on the calling turn just as NaN does", () => {
    const defects = findScenarioWireTruthDefects([scenarioWithProbeReply("negative", -1)]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.reason).toContain("-1");
    expect(defects[0]?.reason).toContain("settles on the calling turn");
  });

  it("negative control: zero and a finite positive latency are both clean", () => {
    // Without this the three cases above would hold over a leg that reported every
    // scripted latency — and zero is not a defect at all: it is the honest way to
    // script no latency, and it settles exactly as an absent `afterMs` does.
    expect(findScenarioWireTruthDefects([scenarioWithProbeReply("no-latency", 0)])).toStrictEqual(
      [],
    );
    expect(
      findScenarioWireTruthDefects([scenarioWithProbeReply("ordinary-latency", 120)]),
    ).toStrictEqual([]);
  });

  it("negative control: the shipped seat board's own replies stay clean", () => {
    expect(findScenarioWireTruthDefects([FLAGSHIP_SCENARIO])).toStrictEqual([]);
  });
});

describe("scenario wire truth — a growth operation the fixture never serves", () => {
  /** The flagship, with one extra reply answering `call`. */
  const scenarioAnswering = (call: string): ConsoleScenario => ({
    ...FLAGSHIP_SCENARIO,
    id: "answers-an-unserved-operation",
    replies: [...FLAGSHIP_SCENARIO.replies, { call, result: {} }],
  });

  it("reports a reply the port refuses without ever reading", () => {
    // The defect this leg was written for, and it shipped: four scenarios scripted an
    // `agent.list` roster while the port refused `agentList`, so the composer's target
    // chip rendered a refusal on every provider-bound surface with a scripted answer
    // sitting unread beside it. `gitflow.prPrepare` is the same shape today — a
    // registered wire method whose operation the fixture deliberately does not serve.
    const defects = findScenarioWireTruthDefects([scenarioAnswering("gitflow.prPrepare")]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.subject).toBe('reply "gitflow.prPrepare"');
    expect(defects[0]?.reason).toContain("does not serve");
  });

  it("passes a served growth operation and a bound daemon method alike", () => {
    // The two ways a scripted reply IS reachable, so the claim above is about the
    // served set rather than about growth replies as a class: `approval.projectionRead`
    // is served by the port, and `run.queueList` is bound, which the fixture bridge
    // answers from the same script whatever the port does. The shipped flagship's own
    // `agent.list` is the third — it is clean under the negative control above, which
    // it was not before that operation joined the served set.
    expect(
      findScenarioWireTruthDefects([scenarioAnswering("approval.projectionRead")]),
    ).toStrictEqual([]);
    expect(findScenarioWireTruthDefects([scenarioAnswering("run.queueList")])).toStrictEqual([]);
  });
});

describe("scenario wire truth — one scripted answer per call", () => {
  it("reports a second entry for a call the first already claims", () => {
    // The leg the latency walk joined rather than replaced: `replyFor` answers with
    // the first match, so the second entry can never be served.
    const shadowed: ConsoleScenario = {
      ...FLAGSHIP_SCENARIO,
      id: "claims-one-call-twice",
      replies: [...FLAGSHIP_SCENARIO.replies, { call: "agent.list", result: { agents: [] } }],
    };

    const defects = findScenarioWireTruthDefects([shadowed]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.subject).toBe('reply "agent.list"');
    expect(defects[0]?.reason).toContain("unreachable");
  });

  it("reports the unreachable entry once, and not also for the latency it carries", () => {
    // A shadowed entry is never reached, so its `afterMs` is a property of a reply
    // the fixture cannot serve. Reporting both would name two things to change where
    // deleting the entry settles it.
    const shadowedWithBadLatency: ConsoleScenario = {
      ...FLAGSHIP_SCENARIO,
      id: "shadowed-and-unspendable",
      replies: [
        ...FLAGSHIP_SCENARIO.replies,
        { call: "agent.list", afterMs: Number.NaN, result: { agents: [] } },
      ],
    };

    const defects = findScenarioWireTruthDefects([shadowedWithBadLatency]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.reason).toContain("unreachable");
  });
});
