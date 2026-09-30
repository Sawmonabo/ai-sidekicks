// Revoking from the palette goes through the list's own two steps, for the named rule. Driven
// through the real list: a palette press that reached the wire would skip the confirmation.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { RememberedRule } from "@ai-sidekicks/contracts";

import { commandRegistry } from "@renderer/registries/commands/window-command-registry.js";
import { RememberedRules } from "../components/RememberedRules.js";
import { FIRST_RULE_ID, SECOND_RULE_ID, rule } from "../remembered-rule.test-support.js";

function renderGrants(options: {
  readonly rules: readonly RememberedRule[];
  readonly revoking?: ReadonlySet<string>;
  readonly onRevoke?: (ruleId: string) => void;
}): void {
  render(
    <RememberedRules
      rules={options.rules}
      unreadableCount={0}
      revokingRuleIds={options.revoking ?? new Set()}
      onRevoke={options.onRevoke ?? vi.fn()}
    />,
  );
}

/** The row this list contributes for one rule, or nothing where it offers none. */
function revokeCommandFor(ruleId: string) {
  return commandRegistry.get(`approvals.ruleRevoke.${ruleId}`);
}

/**
 * Press one contributed row and let the tree settle.
 *
 * The press arrives from outside React, so it is flushed in `act` once here.
 */
function pressRevokeRow(ruleId: string): void {
  act(() => {
    revokeCommandFor(ruleId)?.run();
  });
}

describe("what a contributed row does", () => {
  it("enters the confirmation rather than revoking", () => {
    const onRevoke = vi.fn();
    renderGrants({ rules: [rule()], onRevoke });

    pressRevokeRow(FIRST_RULE_ID);

    // The confirming control is on screen against this rule and nothing reached the wire.
    expect(screen.getByRole("button", { name: "Revoke it" })).not.toBeNull();
    expect(onRevoke).not.toHaveBeenCalled();
  });

  it("settles through the list's own confirming press, for the named rule", () => {
    const onRevoke = vi.fn();
    renderGrants({ rules: [rule(), rule({ ruleId: SECOND_RULE_ID })], onRevoke });

    pressRevokeRow(SECOND_RULE_ID);
    fireEvent.click(screen.getByRole("button", { name: "Revoke it" }));

    expect(onRevoke.mock.calls).toStrictEqual([[SECOND_RULE_ID]]);
  });

  it("negative control: the row never reaches the wire by itself", () => {
    // Without this the cases above would pass over a row wired straight to the mutation.
    const onRevoke = vi.fn();
    renderGrants({ rules: [rule()], onRevoke });

    pressRevokeRow(FIRST_RULE_ID);
    pressRevokeRow(FIRST_RULE_ID);

    expect(onRevoke).not.toHaveBeenCalled();
  });
});
