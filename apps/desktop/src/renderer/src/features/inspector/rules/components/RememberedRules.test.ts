// The rules in force: each row reads what the rule does, and they revoke in two steps. A
// block read as an allow, or a first click that mutated, would be invisible until it mattered.

import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SECOND_RULE_ID, renderGrants, rule } from "../remembered-rule.test-support.js";

describe("only the confirming click mutates", () => {
  it("asks first, and canceling leaves zero mutations", () => {
    const onRevoke = vi.fn();
    renderGrants({ rules: [rule()], onRevoke });
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    expect(onRevoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(onRevoke).not.toHaveBeenCalled();
    // Back to idle: the first control is offered again.
    expect(screen.getByRole("button", { name: "Revoke" })).not.toBeNull();
  });

  it("mutates once, for the named rule, on the confirmation", () => {
    const onRevoke = vi.fn();
    renderGrants({ rules: [rule(), rule({ ruleId: SECOND_RULE_ID })], onRevoke });
    const controls = screen.getAllByRole("button", { name: "Revoke" });
    fireEvent.click(controls[1] as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Revoke it" }));
    expect(onRevoke.mock.calls).toStrictEqual([[SECOND_RULE_ID]]);
  });
});

describe("what each row reads", () => {
  it("reads an allow on its subject at this session", () => {
    renderGrants({ rules: [rule()] });
    expect(screen.getByRole("listitem").textContent).toContain("Allow pnpm test · this session");
  });

  it("reads a block as a block, at this project", () => {
    // Negative control: a row reading every rule as an allow would pass the case above.
    renderGrants({
      rules: [rule({ scope: { kind: "project", pattern: "api.example.com", sense: "block" } })],
    });
    expect(screen.getByRole("listitem").textContent).toContain(
      "Block api.example.com · this project",
    );
  });
});

describe("the empty and short reads", () => {
  it("says the grants could not be read when every row failed the parse", () => {
    // Rows this build could not read are of unknown existence, so the reassuring claim is
    // unavailable.
    renderGrants({ rules: [], unreadableCount: 3 });
    expect(screen.getByText("Standing permissions could not be read.")).not.toBeNull();
    expect(screen.getByText(/not known to be none/u)).not.toBeNull();
    expect(screen.queryByText("No rules yet")).toBeNull();
  });

  it("negative control: an empty list with nothing unreadable still says none is in force", () => {
    // Without this the cases above would pass over a panel reporting every empty read as
    // unreadable.
    renderGrants({ rules: [] });
    expect(screen.getByText("No rules yet")).not.toBeNull();
    expect(screen.queryByText("Standing permissions could not be read.")).toBeNull();
  });

  it("says the list is short when the reply carried rows it could not read", () => {
    renderGrants({ rules: [rule()], unreadableCount: 2 });
    expect(screen.getByText(/shorter than what the background service holds/u)).not.toBeNull();
  });

  it("negative control: a fully readable list makes no such claim", () => {
    renderGrants({ rules: [rule()] });
    expect(screen.queryByText(/shorter than what the background service holds/u)).toBeNull();
  });
});
