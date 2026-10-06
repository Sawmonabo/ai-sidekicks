// A cost names the account that paid by its label, and never by its id: a payer the registry
// does not name reads as the cost alone.

import type { WorkflowCost } from "@ai-sidekicks/contracts/workflow/run/step/record";
import type { ProviderAccountId } from "@ai-sidekicks/contracts/provider/account/record";
import { describe, expect, it } from "vitest";

import { costWithPayer } from "./cost.js";

const COST: WorkflowCost = {
  usdMicros: 7_300_000,
  providerAccountId: "pa-0001" as ProviderAccountId,
};

describe("costWithPayer", () => {
  it("names the payer by its label, and a payer with none by nothing", () => {
    expect(costWithPayer(COST, () => "sam@example.com · Max")).toBe(
      "$7.30 · sam@example.com · Max",
    );
    expect(costWithPayer(COST, () => undefined)).toBe("$7.30");
  });
});
