// The rule in force every Rules suite starts from, parsed through the contract's rule
// schema so no suite asserts against a rule the daemon could not send.

import { RememberedRuleSchema, type RememberedRule } from "@ai-sidekicks/contracts";

export const FIRST_RULE_ID = "019b7a33-3300-7e01-8110-d1a4c1150581";
export const SECOND_RULE_ID = "019b7a33-3300-7e01-8120-d1a4c1150582";

/** One session allow on `pnpm test`, with the members named in `overrides` replaced. */
export function rule(overrides: Readonly<Record<string, unknown>> = {}): RememberedRule {
  return RememberedRuleSchema.parse({
    ruleId: FIRST_RULE_ID,
    category: "tool_execution",
    scope: { kind: "session", pattern: "pnpm test", sense: "allow" },
    madeAtLevel: "ask",
    grantedAt: "2026-01-01T10:00:00.000Z",
    ...overrides,
  });
}
