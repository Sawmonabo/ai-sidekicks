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

import { CONSOLE_DAEMON_METHODS } from "@renderer/services/daemon/daemon-reply-registry.js";
import { FLAGSHIP_SCENARIO } from "@renderer/console/bridge/scenario/flagship/flagship.js";
import { findScenarioWireTruthDefects } from "./contract-check.js";
import { CORPUS_DAEMON_METHODS_NOT_YET_BOUND } from "./reply-checks.js";
import type { ScenarioReply } from "@renderer/services/daemon/scenario-reply.fixture.js";
import type { ConsoleScenario } from "../../../fixtures/scenario.js";

/** A call the flagship scripts no answer for, so a case adds one rather than shadowing one. */
const PROBE_CALL = "presence.read";

/** The flagship, with one extra reply carrying the latency under test. */
function scenarioWithProbeReply(scenarioId: string, afterMs: number): ConsoleScenario {
  const probeReply: ScenarioReply = { call: PROBE_CALL, afterMs, result: {} };
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
    const defects = findScenarioWireTruthDefects([scenarioAnswering("workflow.runList")]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.subject).toBe('reply "workflow.runList"');
    expect(defects[0]?.reason).toContain("registers nowhere");
  });

  it("passes a registered daemon method", () => {
    expect(findScenarioWireTruthDefects([scenarioAnswering("presence.read")])).toStrictEqual([]);
  });

  it("negative control: the shipped seat board answers only registered calls", () => {
    // The real tree, which is where a family's invented name would land. Every call it
    // scripts is admitted by a derived registry rather than by a transcription: the
    // daemon binding table.
    expect(findScenarioWireTruthDefects([FLAGSHIP_SCENARIO])).toStrictEqual([]);
  });

  it("negative control: a bound method is clean through the table, not the transient list", () => {
    // Without this the case above would hold over a leg that admitted every string in
    // reach. The list is EMPTY, so no scripted call is admitted by it today:
    // `presence.read` is clean because the console binds it, and the assertion beside
    // the case is what says the transcription had no part in that.
    expect(CORPUS_DAEMON_METHODS_NOT_YET_BOUND).toStrictEqual([]);
    expect(CONSOLE_DAEMON_METHODS as readonly string[]).toContain("presence.read");
    expect(findScenarioWireTruthDefects([scenarioAnswering("presence.read")])).toStrictEqual([]);
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

describe("scenario wire truth — one scripted answer per call", () => {
  it("reports a second entry for a call the first already claims", () => {
    // The leg the latency walk joined rather than replaced: `replyFor` answers with
    // the first match, so the second entry can never be served.
    const shadowed: ConsoleScenario = {
      ...FLAGSHIP_SCENARIO,
      id: "claims-one-call-twice",
      replies: [...FLAGSHIP_SCENARIO.replies, { call: "session.read", result: {} }],
    };

    const defects = findScenarioWireTruthDefects([shadowed]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.subject).toBe('reply "session.read"');
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
        { call: "session.read", afterMs: Number.NaN, result: {} },
      ],
    };

    const defects = findScenarioWireTruthDefects([shadowedWithBadLatency]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.reason).toContain("unreachable");
  });
});
