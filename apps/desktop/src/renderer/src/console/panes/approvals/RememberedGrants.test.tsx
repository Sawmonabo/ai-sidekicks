// Standing permissions: labelled rather than filtered, and revocable in two steps.
//
// The two claims worth a unit are the ones that would be invisible if they broke.
// A revoked rule that quietly vanished would look exactly like a list that never
// held it, and a revoke control that mutated on the first click would look exactly
// like one that mutated on the second — until someone cancelled.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RememberedGrants } from "./RememberedGrants.js";
import { type RememberedRule } from "./approval-records.js";

function rule(overrides: Partial<RememberedRule> = {}): RememberedRule {
  return {
    ruleId: "rule-01",
    sessionId: "session-one",
    participantId: "participant-you",
    nodeId: "node-local",
    category: "file_write",
    scope: { kind: "session" },
    grantedAt: "2026-01-01T10:00:00.000Z",
    ...overrides,
  };
}

function renderGrants(
  rules: readonly RememberedRule[],
  onRevoke: (ruleId: string) => void = vi.fn(),
  unreadableCount = 0,
): void {
  render(
    <RememberedGrants
      rules={rules}
      unreadableCount={unreadableCount}
      revokingRuleIds={new Set()}
      revokeRefusalByRuleId={new Map()}
      onRevoke={onRevoke}
    />,
  );
}

describe("revoked rules are labelled, never filtered", () => {
  it("renders a revoked rule beside a live one and names the trigger", () => {
    renderGrants([
      rule(),
      rule({
        ruleId: "rule-02",
        revokedAt: "2026-01-02T10:00:00.000Z",
        invalidationTrigger: "membership_change",
      }),
    ]);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText(/grantor.s membership changed/u)).not.toBeNull();
    // The audit history is the default view, so exactly one row is still live and
    // offers the control — the revoked one offers none.
    expect(screen.getAllByRole("button", { name: "Revoke" })).toHaveLength(1);
  });

  it("says the reply named no trigger rather than inventing one", () => {
    renderGrants([rule({ revokedAt: "2026-01-02T10:00:00.000Z" })]);
    expect(screen.getByText(/named no trigger/u)).not.toBeNull();
  });

  it("carries an unrecognized trigger verbatim", () => {
    // Negative control on the phrase table: an unknown token must reach the screen
    // as itself, or a future trigger would render as a blank sentence.
    renderGrants([
      rule({ revokedAt: "2026-01-02T10:00:00.000Z", invalidationTrigger: "heat_death" }),
    ]);
    expect(screen.getByText(/heat_death/u)).not.toBeNull();
  });
});

describe("only the confirming click mutates", () => {
  it("asks first, and cancelling leaves zero mutations", () => {
    const onRevoke = vi.fn();
    renderGrants([rule()], onRevoke);
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    expect(onRevoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(onRevoke).not.toHaveBeenCalled();
    // Back to idle: the first control is offered again, so a cancel is a return
    // rather than a dead end.
    expect(screen.getByRole("button", { name: "Revoke" })).not.toBeNull();
  });

  it("mutates once, for the named rule, on the confirmation", () => {
    const onRevoke = vi.fn();
    renderGrants([rule(), rule({ ruleId: "rule-02" })], onRevoke);
    const controls = screen.getAllByRole("button", { name: "Revoke" });
    fireEvent.click(controls[1] as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Revoke it" }));
    expect(onRevoke.mock.calls).toStrictEqual([["rule-02"]]);
  });
});

describe("the grant's own facts", () => {
  it("names the grantor, the node, and the boundary the pattern covers", () => {
    renderGrants([rule({ scope: { kind: "run", pattern: "src/**" }, runId: "run-7" })]);
    expect(screen.getByText("participant-you")).not.toBeNull();
    expect(screen.getByText("node-local")).not.toBeNull();
    expect(screen.getByText("src/**")).not.toBeNull();
    expect(screen.getByText("run-7")).not.toBeNull();
  });

  it("says a pattern-less rule covers the whole category", () => {
    renderGrants([rule()]);
    expect(screen.getByText(/whole category inside that boundary/u)).not.toBeNull();
  });

  it("marks a scope kind outside the ratified set rather than asserting it", () => {
    renderGrants([rule({ scope: { kind: "forever" } })]);
    const chip = screen.getByText("forever").closest(".meridian-chip");
    expect(chip?.className).toContain("meridian-chip--failure");
  });

  it("negative control: a ratified kind is named and takes the neutral treatment", () => {
    // Without this the case above would also pass over a component that marked
    // every scope chip as unrecognized.
    renderGrants([rule()]);
    const chip = screen.getByText("This whole session").closest(".meridian-chip");
    expect(chip?.className).not.toContain("meridian-chip--failure");
  });
});

describe("the empty and short reads", () => {
  it("says no permission is in force rather than showing an empty list", () => {
    renderGrants([]);
    expect(screen.getByText("No standing permission is in force.")).not.toBeNull();
    expect(screen.queryByRole("listitem")).toBeNull();
  });

  it("says the list is short when the reply carried rows it could not read", () => {
    renderGrants([rule()], vi.fn(), 2);
    expect(screen.getByText(/shorter than what the daemon holds/u)).not.toBeNull();
  });

  it("negative control: a fully readable list makes no such claim", () => {
    renderGrants([rule()]);
    expect(screen.queryByText(/shorter than what the daemon holds/u)).toBeNull();
  });
});
