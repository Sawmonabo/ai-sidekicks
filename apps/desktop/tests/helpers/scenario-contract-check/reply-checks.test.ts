// The reply legs: one answer per call, and a latency the frozen clock can spend.
//
// Cases drive `findScenarioContractDefects`, the only function a scenario is measured through, and
// start from the concurrent-streaming scenario so a reported defect is attributable to the reply.

import { describe, expect, it } from "vitest";

import { REGISTERED_DAEMON_METHODS } from "@renderer/services/daemon/daemon-method-contract.js";
import { CONCURRENT_STREAMING_SCENARIO } from "../../../fixtures/scenarios/concurrent-streaming.js";
import { findScenarioContractDefects } from "./contract-check.js";
import { CORPUS_DAEMON_METHODS_NOT_YET_BOUND } from "./reply-checks.js";
import type { ScenarioReply } from "@renderer/services/daemon/scenario-reply.fixture.js";
import type { Scenario } from "../../../fixtures/scenario.js";

/** A call the concurrent-streaming scenario scripts no answer for, so a case adds one. */
const PROBE_CALL = "presence.read";

/** The concurrent-streaming scenario, with one extra reply carrying the latency under test. */
function scenarioWithProbeReply(scenarioId: string, afterMs: number): Scenario {
  const probeReply: ScenarioReply = { call: PROBE_CALL, afterMs, result: {} };
  return {
    ...CONCURRENT_STREAMING_SCENARIO,
    id: scenarioId,
    replies: [...CONCURRENT_STREAMING_SCENARIO.replies, probeReply],
  };
}

describe("scenario wire truth — a call the corpus registers nowhere", () => {
  /** The concurrent-streaming scenario, with one extra reply answering `call`. */
  const scenarioAnswering = (call: string): Scenario => ({
    ...CONCURRENT_STREAMING_SCENARIO,
    id: "answers-a-call",
    replies: [...CONCURRENT_STREAMING_SCENARIO.replies, { call, result: {} }],
  });

  it("reports a scripted reply to a method nothing registers", () => {
    // A scenario answering `workflow.runList` would render a view that looks served and ship a
    // reference image of it.
    const defects = findScenarioContractDefects([scenarioAnswering("workflow.runList")]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.subject).toBe('reply "workflow.runList"');
    expect(defects[0]?.reason).toContain("registers nowhere");
  });

  it("passes a registered daemon method", () => {
    expect(findScenarioContractDefects([scenarioAnswering("presence.read")])).toStrictEqual([]);
  });

  it("negative control: the shipped scenarios answer only registered calls", () => {
    // The real tree is where a feature's invented name would land; every call it scripts is
    // admitted by the daemon binding table.
    expect(findScenarioContractDefects([CONCURRENT_STREAMING_SCENARIO])).toStrictEqual([]);
  });

  it("negative control: a bound method is clean through the table, not the transient list", () => {
    // The list is empty, so `presence.read` is clean because the console binds it, not because a
    // hand-written entry admitted it.
    expect(CORPUS_DAEMON_METHODS_NOT_YET_BOUND).toStrictEqual([]);
    expect(REGISTERED_DAEMON_METHODS as readonly string[]).toContain("presence.read");
    expect(findScenarioContractDefects([scenarioAnswering("presence.read")])).toStrictEqual([]);
  });
});

describe("scenario wire truth — a scripted latency the frozen clock cannot spend", () => {
  it("reports a latency of Infinity, which parks the reply past every finite advance", () => {
    // No advance reaches the tick this parks at, so the reply settles only on teardown.
    const defects = findScenarioContractDefects([
      scenarioWithProbeReply("parks-forever", Number.POSITIVE_INFINITY),
    ]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.subject).toBe(`reply "${PROBE_CALL}"`);
    expect(defects[0]?.reason).toContain("Infinity");
    expect(defects[0]?.reason).toContain("loading state");
  });

  it("reports a latency of NaN, which the engine's own test refuses and never parks", () => {
    // The fixture spends a latency only above zero, so a `NaN` reply settles on the calling turn
    // and the loading state the scenario claims to exercise is unreachable.
    const defects = findScenarioContractDefects([
      scenarioWithProbeReply("never-parks", Number.NaN),
    ]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.subject).toBe(`reply "${PROBE_CALL}"`);
    expect(defects[0]?.reason).toContain("NaN");
    expect(defects[0]?.reason).toContain("settles on the calling turn");
  });

  it("reports a negative latency, which settles on the calling turn just as NaN does", () => {
    const defects = findScenarioContractDefects([scenarioWithProbeReply("negative", -1)]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.reason).toContain("-1");
    expect(defects[0]?.reason).toContain("settles on the calling turn");
  });

  it("negative control: zero and a finite positive latency are both clean", () => {
    // Without this the cases above would hold over a leg that reported every latency; zero is the
    // honest way to script none.
    expect(findScenarioContractDefects([scenarioWithProbeReply("no-latency", 0)])).toStrictEqual(
      [],
    );
    expect(
      findScenarioContractDefects([scenarioWithProbeReply("ordinary-latency", 120)]),
    ).toStrictEqual([]);
  });

  it("negative control: the concurrent-streaming scenario's own replies stay clean", () => {
    expect(findScenarioContractDefects([CONCURRENT_STREAMING_SCENARIO])).toStrictEqual([]);
  });
});

describe("scenario wire truth — one scripted answer per call", () => {
  it("reports a second entry for a call the first already claims", () => {
    // `replyFor` answers with the first match, so the second entry can never be served.
    const shadowed: Scenario = {
      ...CONCURRENT_STREAMING_SCENARIO,
      id: "claims-one-call-twice",
      replies: [...CONCURRENT_STREAMING_SCENARIO.replies, { call: "session.read", result: {} }],
    };

    const defects = findScenarioContractDefects([shadowed]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.subject).toBe('reply "session.read"');
    expect(defects[0]?.reason).toContain("unreachable");
  });

  it("reports the unreachable entry once, and not also for the latency it carries", () => {
    // A shadowed entry is never reached, so reporting its latency too would name two things to
    // change where deleting the entry settles it.
    const shadowedWithBadLatency: Scenario = {
      ...CONCURRENT_STREAMING_SCENARIO,
      id: "shadowed-and-unspendable",
      replies: [
        ...CONCURRENT_STREAMING_SCENARIO.replies,
        { call: "session.read", afterMs: Number.NaN, result: {} },
      ],
    };

    const defects = findScenarioContractDefects([shadowedWithBadLatency]);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.reason).toContain("unreachable");
  });
});
