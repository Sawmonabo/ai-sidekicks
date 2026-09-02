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
