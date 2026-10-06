// A cost names the account that paid by its label, and never by its id: a payer the read
// registry no longer lists reads as a removed account, and before the read the cost stands alone.

import type { WorkflowCost } from "@ai-sidekicks/contracts/workflow/run/step/record";
import type { ProviderAccountId } from "@ai-sidekicks/contracts/provider/account/record";
import { describe, expect, it } from "vitest";

import { costWithPayer } from "./cost.js";

const COST: WorkflowCost = {
  usdMicros: 7_300_000,
  providerAccountId: "pa-0001" as ProviderAccountId,
};

describe("costWithPayer", () => {
  it("names a listed payer by its label, a removed one in words, and never by its id", () => {
    expect(costWithPayer(COST, () => ({ kind: "listed", label: "sam@example.com · Max" }))).toBe(
      "$7.30 · sam@example.com · Max",
    );
    // The registry was read and no longer lists the account.
    expect(costWithPayer(COST, () => ({ kind: "removed" }))).toBe("$7.30 · Removed account");
    // Before the registry is read nothing is known about the payer, so the cost stands alone.
    expect(costWithPayer(COST, () => ({ kind: "unread" }))).toBe("$7.30");
  });
});
