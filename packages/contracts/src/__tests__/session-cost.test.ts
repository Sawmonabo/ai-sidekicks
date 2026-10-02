// The budget read is a figure a person is charged by. These cases hold that every amount is
// whole micro-dollars and that a subtree never costs less than its own agent.
import { describe, expect, it } from "vitest";

import { OrchestrationBudgetStateSchema } from "../session-cost.js";

const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const LEAD_AGENT_ID = "77777777-7777-4777-8777-777777777777";

const BUDGET = {
  sessionId: SESSION_ID,
  spendLimitUsdMicros: null,
  tokensPerRun: null,
  committedSpendUsdMicros: 9000,
  agentSpend: [
    {
      agent: { kind: "agent", agentId: LEAD_AGENT_ID },
      ownUsdMicros: 4700,
      subtreeUsdMicros: 9000,
    },
  ],
} as const;

describe("orchestration.budgetRead", () => {
  it("accepts the lead's own spend beside its subtree's", () => {
    expect(OrchestrationBudgetStateSchema.safeParse(BUDGET).success).toBe(true);
  });

  it("refuses a subtree that costs less than its own agent", () => {
    const budget = {
      ...BUDGET,
      agentSpend: [{ ...BUDGET.agentSpend[0], ownUsdMicros: 9001 }],
    };
    expect(OrchestrationBudgetStateSchema.safeParse(budget).success).toBe(false);
  });

  it("refuses a fraction of a micro-dollar", () => {
    expect(
      OrchestrationBudgetStateSchema.safeParse({ ...BUDGET, committedSpendUsdMicros: 9000.5 })
        .success,
    ).toBe(false);
  });
});
