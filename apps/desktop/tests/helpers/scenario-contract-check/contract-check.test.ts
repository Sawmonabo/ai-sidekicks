// Every scenario in the catalog is one a daemon could deliver: its beats, replies and caller
// pass the wire contract `@ai-sidekicks/contracts` declares, so a contract change that strands a
// scenario fails here rather than leaving the fixture tiers to test a wire nothing sends.

import { describe, expect, it } from "vitest";

import { SCENARIOS } from "../../../fixtures/index.js";
import { findScenarioContractDefects } from "./contract-check.js";

describe("scenario wire truth — the shipped scenarios", () => {
  it("accepts every scenario a feature has landed in the registry", () => {
    expect(
      findScenarioContractDefects(SCENARIOS).map(
        (defect) => `${defect.scenarioId}: ${defect.subject} — ${defect.reason}`,
      ),
    ).toStrictEqual([]);
  });
});
