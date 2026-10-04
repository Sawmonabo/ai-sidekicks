// The rule in force every Rules suite starts from, parsed through the contract's schema so no
// suite asserts against a rule the daemon could not send, and the one render of the list the
// suites drive.

import { render } from "@testing-library/react";
import { vi } from "vitest";

import { RememberedRuleSchema, type RememberedRule } from "@ai-sidekicks/contracts/approval";

import { RememberedRules } from "./components/RememberedRules.js";

/** The id of the first rule a suite lists. */
export const FIRST_RULE_ID = "019b7a33-3300-7e01-8110-d1a4c1150581";
/** The id of the second rule a suite lists. */
export const SECOND_RULE_ID = "019b7a33-3300-7e01-8120-d1a4c1150582";

/** One session allow on `pnpm test`, with the members named in `overrides` replaced. */
export function rule(overrides: Readonly<Record<string, unknown>> = {}): RememberedRule {
  return RememberedRuleSchema.parse({
    ruleId: FIRST_RULE_ID,
    category: "tool_execution",
    scope: { kind: "session", pattern: "pnpm test", sense: "allow" },
    grantedAt: "2026-01-01T10:00:00.000Z",
    ...overrides,
  });
}

/** Render the list over these rules; every member not named falls back to a quiet default. */
export function renderGrants(options: {
  readonly rules: readonly RememberedRule[];
  readonly revoking?: ReadonlySet<string>;
  readonly onRevoke?: (ruleId: string) => void;
  readonly unreadableCount?: number;
}): void {
  render(
    <RememberedRules
      rules={options.rules}
      unreadableCount={options.unreadableCount ?? 0}
      revokingRuleIds={options.revoking ?? new Set()}
      onRevoke={options.onRevoke ?? vi.fn()}
    />,
  );
}
