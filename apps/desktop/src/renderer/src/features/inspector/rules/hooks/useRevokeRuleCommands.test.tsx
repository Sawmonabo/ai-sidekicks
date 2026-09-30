// Revoking from the palette: the same rules, the same two steps, one act.
//
// Driven through the real list, since the claims are about which rules the palette offers
// against which show a Revoke button; separate builder and component cases would pass over
// drift. A palette press that reached the wire would be a weaker path to a two-step act.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { RememberedRule } from "@ai-sidekicks/contracts";

import { commandRegistry } from "@renderer/registries/commands/window-command-registry.js";
import { RememberedRules } from "../components/RememberedRules.js";
import { offersRevoke } from "../contributions/revoke-rule-commands.js";
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

describe("which rules the palette offers to revoke", () => {
  it("offers a row for every rule whose button is on screen", () => {
    renderGrants({ rules: [rule(), rule({ ruleId: SECOND_RULE_ID })] });

    expect(screen.getAllByRole("button", { name: "Revoke" })).toHaveLength(2);
    expect(revokeCommandFor(FIRST_RULE_ID)).not.toBeUndefined();
    expect(revokeCommandFor(SECOND_RULE_ID)).not.toBeUndefined();
  });

  it("names the rule only where there is another to confuse it with", () => {
    renderGrants({ rules: [rule()] });
    expect(revokeCommandFor(FIRST_RULE_ID)?.title).toBe("Revoke the standing permission");
    cleanup();

    renderGrants({ rules: [rule(), rule({ ruleId: SECOND_RULE_ID })] });
    expect(revokeCommandFor(FIRST_RULE_ID)?.title).toBe(
      `Revoke standing permission ${FIRST_RULE_ID}`,
    );
  });

  it("offers nothing for a rule whose revocation is already settling", () => {
    // The control reports the revocation instead of offering a second press.
    renderGrants({ rules: [rule()], revoking: new Set([FIRST_RULE_ID]) });

    expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
    expect(revokeCommandFor(FIRST_RULE_ID)).toBeUndefined();
  });

  it("negative control: the shared reading is what withholds them", () => {
    // Without this the case above would pass over a contribution filtering on its own copy.
    expect(offersRevoke(rule(), new Set())).toBe(true);
    expect(offersRevoke(rule(), new Set([FIRST_RULE_ID]))).toBe(false);
  });
});

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

  it("is cancelable from the control, with zero mutations", () => {
    const onRevoke = vi.fn();
    renderGrants({ rules: [rule()], onRevoke });

    pressRevokeRow(FIRST_RULE_ID);
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));

    expect(onRevoke).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Revoke" })).not.toBeNull();
  });

  it("negative control: the row never reaches the wire by itself", () => {
    // Without this the cases above would pass over a row wired straight to the mutation.
    const onRevoke = vi.fn();
    renderGrants({ rules: [rule()], onRevoke });

    pressRevokeRow(FIRST_RULE_ID);
    pressRevokeRow(FIRST_RULE_ID);

    expect(onRevoke).not.toHaveBeenCalled();
  });

  it("negative control: the rows go when the list does", () => {
    renderGrants({ rules: [rule()] });
    expect(revokeCommandFor(FIRST_RULE_ID)).not.toBeUndefined();

    cleanup();

    expect(revokeCommandFor(FIRST_RULE_ID)).toBeUndefined();
  });
});
