// Every scenario in the catalog is one a daemon could deliver: its beats, replies and caller
// pass the wire contract `@ai-sidekicks/contracts` declares, so a contract change that strands a
// scenario fails here rather than leaving the fixture tiers to test a wire nothing sends.

import { describe, expect, it } from "vitest";

import { SCENARIOS } from "@fixtures/index.js";
import { EMPTY_SESSION_SCENARIO } from "@fixtures/scenarios/empty-session.js";
import type { Scenario } from "@fixtures/scenario.js";
import { findScenarioContractDefects } from "./contract-check.js";

describe("scenario contract — the shipped scenarios", () => {
  it("accepts every scenario a feature has landed in the registry", () => {
    expect(
      findScenarioContractDefects(SCENARIOS).map(
        (defect) => `${defect.scenarioId}: ${defect.subject} — ${defect.reason}`,
      ),
    ).toStrictEqual([]);
  });

  it("reports an invented call and a second reply to the same call", () => {
    const [sessionRead] = EMPTY_SESSION_SCENARIO.replies;
    if (sessionRead === undefined) {
      throw new Error("the empty-session scenario no longer answers session.read");
    }
    const broken: Scenario = {
      ...EMPTY_SESSION_SCENARIO,
      replies: [sessionRead, sessionRead, { call: "workflow.runList", result: [] }],
    };

    expect(findScenarioContractDefects([broken]).map((defect) => defect.subject)).toStrictEqual([
      'reply "session.read"',
      'reply "workflow.runList"',
    ]);
  });

  it("reports a scripted value its method's response schema refuses", () => {
    const drifted: Scenario = {
      ...EMPTY_SESSION_SCENARIO,
      replies: [{ call: "mcp.list", result: { servers: [{ serverName: "filesystem" }] } }],
    };

    expect(findScenarioContractDefects([drifted]).map((defect) => defect.subject)).toStrictEqual([
      'reply "mcp.list"',
    ]);
  });
});
