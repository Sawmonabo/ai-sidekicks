// Revoking from the palette: the same rules, the same two steps, one act.
//
// Driven through the real list rather than over the row builder alone, because the
// claims are about a COINCIDENCE — which rules the palette offers against which rules
// show a Revoke button, and what a pressed row does to the control beside it. A suite
// that asserted the builder's output and the component's buttons in separate cases
// would pass over exactly the drift the shared predicate exists to prevent.
//
// The sharpest claim is the one about what a row may NOT do: revocation is
// irreversible from this surface, so a palette press that reached the wire would be a
// weaker second path to an act the list made deliberately two-step.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { type RememberedRule } from "../../../bridge/index.js";
import { consoleCommands } from "../../../palette/index.js";
import { RememberedGrants } from "./RememberedGrants.js";
import { offersRevoke } from "./revoke-commands.js";

const FIRST_RULE = "rule-01";
const SECOND_RULE = "rule-02";

function rule(overrides: Partial<RememberedRule> = {}): RememberedRule {
  return {
    ruleId: FIRST_RULE,
    sessionId: "session-one",
    userId: "user-you",
    nodeId: "node-local",
    category: "file_write",
    scope: { kind: "session" },
    grantedAt: "2026-01-01T10:00:00.000Z",
    ...overrides,
  };
}

function renderGrants(options: {
  readonly rules: readonly RememberedRule[];
  readonly revoking?: ReadonlySet<string>;
  readonly onRevoke?: (ruleId: string) => void;
}): void {
  render(
    <RememberedGrants
      rules={options.rules}
      unreadableCount={0}
      revokingRuleIds={options.revoking ?? new Set()}
      revokeRefusalByRuleId={new Map()}
      onRevoke={options.onRevoke ?? vi.fn()}
    />,
  );
}

/** The row this list contributes for one rule, or nothing where it offers none. */
function revokeCommandFor(ruleId: string) {
  return consoleCommands.get(`approvals.ruleRevoke.${ruleId}`);
}

/**
 * Press one contributed row and let the tree settle.
 *
 * A palette press arrives from outside React — the registry holds the callback and
 * the dialog invokes it — so the state it moves is flushed here rather than awaited
 * per case. That is what the palette itself does on a real press; wrapping it once
 * keeps every case below asserting the SETTLED surface rather than a frame of it.
 */
function pressRevokeRow(ruleId: string): void {
  act(() => {
    revokeCommandFor(ruleId)?.run();
  });
}

describe("which rules the palette offers to revoke", () => {
  it("offers a row for every rule whose button is on screen", () => {
    renderGrants({ rules: [rule(), rule({ ruleId: SECOND_RULE })] });

    expect(screen.getAllByRole("button", { name: "Revoke" })).toHaveLength(2);
    expect(revokeCommandFor(FIRST_RULE)).not.toBeUndefined();
    expect(revokeCommandFor(SECOND_RULE)).not.toBeUndefined();
  });

  it("names the rule only where there is another to confuse it with", () => {
    renderGrants({ rules: [rule()] });
    expect(revokeCommandFor(FIRST_RULE)?.title).toBe("Revoke the standing permission");
    cleanup();

    renderGrants({ rules: [rule(), rule({ ruleId: SECOND_RULE })] });
    expect(revokeCommandFor(FIRST_RULE)?.title).toBe(`Revoke standing permission ${FIRST_RULE}`);
  });

  it("offers nothing for a rule already revoked, exactly as the list does", () => {
    renderGrants({
      rules: [rule({ revokedAt: "2026-01-02T10:00:00.000Z" }), rule({ ruleId: SECOND_RULE })],
    });

    expect(screen.getAllByRole("button", { name: "Revoke" })).toHaveLength(1);
    expect(revokeCommandFor(FIRST_RULE)).toBeUndefined();
    expect(revokeCommandFor(SECOND_RULE)).not.toBeUndefined();
  });

  it("offers nothing for a rule whose revocation is already settling", () => {
    // The control reports the revocation rather than offering a second press, so a
    // palette row here would be a press with nothing to press.
    renderGrants({ rules: [rule()], revoking: new Set([FIRST_RULE]) });

    expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
    expect(revokeCommandFor(FIRST_RULE)).toBeUndefined();
  });

  it("negative control: the shared reading is what withholds them", () => {
    // Without this the two cases above would pass over a contribution that filtered
    // on its own copy of the rule — which is the state this predicate replaced.
    expect(offersRevoke(rule(), new Set())).toBe(true);
    expect(offersRevoke(rule({ revokedAt: "2026-01-02T10:00:00.000Z" }), new Set())).toBe(false);
    expect(offersRevoke(rule(), new Set([FIRST_RULE]))).toBe(false);
  });
});

describe("what a contributed row does", () => {
  it("enters the confirmation rather than revoking", () => {
    const onRevoke = vi.fn();
    renderGrants({ rules: [rule()], onRevoke });

    pressRevokeRow(FIRST_RULE);

    // The confirming control is now on screen against this rule, and nothing has
    // reached the wire: the palette armed the same two-step the button arms.
    expect(screen.getByRole("button", { name: "Revoke it" })).not.toBeNull();
    expect(onRevoke).not.toHaveBeenCalled();
  });

  it("settles through the list's own confirming press, for the named rule", () => {
    const onRevoke = vi.fn();
    renderGrants({ rules: [rule(), rule({ ruleId: SECOND_RULE })], onRevoke });

    pressRevokeRow(SECOND_RULE);
    fireEvent.click(screen.getByRole("button", { name: "Revoke it" }));

    expect(onRevoke.mock.calls).toStrictEqual([[SECOND_RULE]]);
  });

  it("is cancellable from the control, with zero mutations", () => {
    const onRevoke = vi.fn();
    renderGrants({ rules: [rule()], onRevoke });

    pressRevokeRow(FIRST_RULE);
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));

    expect(onRevoke).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Revoke" })).not.toBeNull();
  });

  it("negative control: the row never reaches the wire by itself", () => {
    // Without this every case above would pass over a row wired straight to the
    // mutation — which is the one thing a palette entry for this act may not be.
    const onRevoke = vi.fn();
    renderGrants({ rules: [rule()], onRevoke });

    pressRevokeRow(FIRST_RULE);
    pressRevokeRow(FIRST_RULE);

    expect(onRevoke).not.toHaveBeenCalled();
  });

  it("negative control: the rows go when the list does", () => {
    renderGrants({ rules: [rule()] });
    expect(revokeCommandFor(FIRST_RULE)).not.toBeUndefined();

    cleanup();

    expect(revokeCommandFor(FIRST_RULE)).toBeUndefined();
  });
});
