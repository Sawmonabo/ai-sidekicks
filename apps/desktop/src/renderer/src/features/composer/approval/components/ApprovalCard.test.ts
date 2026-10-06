// What an answer sends: an answer the contract accepts, no second press while one is in flight,
// the three answers in their fixed order with the standing allow absent where none is offered, a
// rule made only by the press whose label names it, the project scope and the host block only
// where offered, a keyboard-walkable row, and the requested resource shown in full before the
// person answers. The card and the palette rows withdraw together on a settled refusal. Payload
// assertions drive the real `onResolve`, so they check the wire request.

import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { refuse, type Refusal } from "#renderer/lib/refusal/contract.js";
import { approvalCommandRows, type ApprovalCommandInput } from "../contributions/commands.js";
import { isAcceptedAnswer, pendingRecord } from "../record.test-support.js";
import { renderCard } from "./ApprovalCard.test-support.js";

/** The faces of the action row, by their words, in the order they stand. */
function answerFaces(): readonly string[] {
  const actions = screen.getByRole("toolbar", { name: "Answer this request" });
  return [...actions.querySelectorAll(".meridian-approval-card__action")].map(
    (face) => face.textContent,
  );
}

/** Opens the arrow named `arrowLabel` and presses its row named `rowLabel`. */
function pressArrowRow(arrowLabel: string, rowLabel: string): void {
  fireEvent.click(screen.getByRole("button", { name: arrowLabel }));
  fireEvent.click(screen.getByRole("menuitem", { name: rowLabel }));
}

describe("what an answer sends", () => {
  it("sends Approve once as an answer the contract accepts, naming no scope and no rule", () => {
    const requests = renderCard(pendingRecord());
    fireEvent.click(screen.getByRole("button", { name: "Approve once" }));
    expect(requests).toHaveLength(1);
    expect(isAcceptedAnswer(requests[0])).toBe(true);
    expect(requests[0]).toStrictEqual({
      approvalRequestId: pendingRecord().id,
      decision: "approved",
      clientResolutionId: expect.any(String),
    });
  });

  it("sends a plain Decline with no rule, and mints a fresh client resolution id for every press", () => {
    // Two presses sharing an id would be two answers the daemon cannot tell apart.
    const requests = renderCard(pendingRecord());
    fireEvent.click(screen.getByRole("button", { name: "Approve once" }));
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    expect(requests[1]?.decision).toBe("rejected");
    expect(requests[1] && "rememberedScope" in requests[1]).toBe(false);
    expect(requests[0]?.clientResolutionId).not.toBe(requests[1]?.clientResolutionId);
  });
});

describe("a press while the answer is in flight", () => {
  it("disables every answer and every arrow while this record's call is in flight", () => {
    renderCard(pendingRecord({ category: "network_access", subject: "api.example.com" }), true);
    const actions = screen.getByRole("toolbar", { name: "Answer this request" });
    const buttons = [...actions.querySelectorAll("button")];
    // Three faces and the two arrows.
    expect(buttons).toHaveLength(5);
    for (const button of buttons) {
      expect(button.disabled).toBe(true);
    }
  });
});

describe("the three answers", () => {
  it("stand in one fixed order, the standing allow naming the ask's own subject", () => {
    renderCard(pendingRecord({ subject: "pnpm test" }));
    expect(answerFaces()).toEqual([
      "Decline",
      "Always allow pnpm test this session",
      "Approve once",
    ]);
  });

  it("drop the standing allow, arrow and all, where the ask may not carry one", () => {
    renderCard(pendingRecord({ standingAllowOffered: false, projectScopeOffered: false }));
    expect(answerFaces()).toEqual(["Decline", "Approve once"]);
    expect(screen.queryByRole("button", { name: "Other scopes for this rule" })).toBeNull();
  });
});

describe("the standing allow makes the rule its label names", () => {
  it("allows the ask's own subject for this session from its face", () => {
    const requests = renderCard(pendingRecord({ subject: "pnpm test" }));
    fireEvent.click(screen.getByRole("button", { name: "Always allow pnpm test this session" }));
    expect(requests[0]?.decision).toBe("approved");
    expect(requests[0]?.rememberedScope).toStrictEqual({
      kind: "session",
      pattern: "pnpm test",
      sense: "allow",
    });
    expect(isAcceptedAnswer(requests[0])).toBe(true);
  });

  it("allows it for the whole project from its arrow's second row", () => {
    const requests = renderCard(pendingRecord({ subject: "pnpm test" }));
    pressArrowRow("Other scopes for this rule", "Always in this project");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.rememberedScope).toStrictEqual({
      kind: "project",
      pattern: "pnpm test",
      sense: "allow",
    });
    expect(isAcceptedAnswer(requests[0])).toBe(true);
  });

  it("carries no arrow where the project scope is not offered", () => {
    renderCard(pendingRecord({ projectScopeOffered: false }));
    expect(screen.queryByRole("button", { name: "Other scopes for this rule" })).toBeNull();
    // Negative control: the face itself stays.
    expect(answerFaces()).toContain("Always allow approval.ts this session");
  });
});

describe("a network ask's Decline can block the host", () => {
  it("blocks the host for this session from Decline's arrow", () => {
    const requests = renderCard(
      pendingRecord({ category: "network_access", subject: "api.example.com" }),
    );
    pressArrowRow("Other ways to decline", "Block api.example.com this session");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.decision).toBe("rejected");
    expect(requests[0]?.rememberedScope).toStrictEqual({
      kind: "session",
      pattern: "api.example.com",
      sense: "block",
    });
    expect(isAcceptedAnswer(requests[0])).toBe(true);
  });

  it("blocks the host for the whole project from the arrow's second row, only where offered", () => {
    const requests = renderCard(
      pendingRecord({ category: "network_access", subject: "api.example.com" }),
    );
    pressArrowRow("Other ways to decline", "Always in this project");
    expect(requests[0]?.decision).toBe("rejected");
    expect(requests[0]?.rememberedScope).toStrictEqual({
      kind: "project",
      pattern: "api.example.com",
      sense: "block",
    });
    expect(isAcceptedAnswer(requests[0])).toBe(true);
  });

  it("offers no project block where no project rule may be written", () => {
    renderCard(
      pendingRecord({
        category: "network_access",
        subject: "api.example.com",
        projectScopeOffered: false,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Other ways to decline" }));
    expect(screen.queryByRole("menuitem", { name: "Always in this project" })).toBeNull();
    // Negative control: the session block stays.
    expect(
      screen.getByRole("menuitem", { name: "Block api.example.com this session" }),
    ).toBeTruthy();
  });

  it("negative control: a file write's Decline keeps its single press", () => {
    renderCard(pendingRecord());
    expect(screen.queryByRole("button", { name: "Other ways to decline" })).toBeNull();
  });
});

describe("the action row is keyboard-walkable", () => {
  it("moves focus between the faces with an arrow and with a vim key, and suppresses the page scroll", () => {
    renderCard(pendingRecord());
    const actions = screen.getByRole("toolbar", { name: "Answer this request" });
    const decline = screen.getByRole("button", { name: "Decline" });
    const allow = screen.getByRole("button", { name: "Always allow approval.ts this session" });
    decline.focus();
    const arrowHandled = fireEvent.keyDown(actions, { key: "ArrowRight" });
    // The standing allow's arrow sits between the two faces and is skipped.
    expect(document.activeElement).toBe(allow);
    // `fireEvent` answers false when a handler called `preventDefault`.
    expect(arrowHandled).toBe(false);
    fireEvent.keyDown(actions, { key: "h" });
    expect(document.activeElement).toBe(decline);
  });

  it("stops at each end rather than wrapping around", () => {
    renderCard(pendingRecord());
    const actions = screen.getByRole("toolbar", { name: "Answer this request" });
    const decline = screen.getByRole("button", { name: "Decline" });
    const approveOnce = screen.getByRole("button", { name: "Approve once" });
    decline.focus();
    fireEvent.keyDown(actions, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(decline);
    approveOnce.focus();
    fireEvent.keyDown(actions, { key: "ArrowRight" });
    expect(document.activeElement).toBe(approveOnce);
  });

  it("negative control: a key the row does not own moves nothing and is not suppressed", () => {
    renderCard(pendingRecord());
    const actions = screen.getByRole("toolbar", { name: "Answer this request" });
    const decline = screen.getByRole("button", { name: "Decline" });
    decline.focus();
    expect(fireEvent.keyDown(actions, { key: "ArrowDown" })).toBe(true);
    expect(document.activeElement).toBe(decline);
  });
});

describe("the requested resource is the structured value the reply carried", () => {
  it("renders every member of the descriptor as a pair", () => {
    renderCard(
      pendingRecord({
        resourceDescriptor: { command: "git push --force origin main", branch: "main" },
      }),
    );
    const disclosure = screen.getByRole("button", { name: "What was asked for" });
    fireEvent.click(disclosure);
    expect(screen.getByText("command")).not.toBeNull();
    expect(screen.getByText("git push --force origin main")).not.toBeNull();
    expect(screen.getByText("branch")).not.toBeNull();
    // A string member renders without added quotes, so a JSON dump of the descriptor fails.
    expect(screen.queryByText(/^\{/u)).toBeNull();
  });

  it("renders a non-string member as its JSON form rather than dropping it", () => {
    renderCard(pendingRecord({ resourceDescriptor: { bytes: 4096, dryRun: false } }));
    fireEvent.click(screen.getByRole("button", { name: "What was asked for" }));
    expect(screen.getByText("4096")).not.toBeNull();
    expect(screen.getByText("false")).not.toBeNull();
  });
});

const ALREADY_RESOLVED: Refusal = refuse(
  "approvals",
  "approval.already_resolved",
  "Answered elsewhere.",
);
const RETRYABLE: Refusal = refuse("approvals", "approval.decision_conflict", "Two answers raced.");

/** The palette's view of one record and one refusal against it. */
function rowsFor(refusalForRecord: Refusal): ApprovalCommandInput {
  const record = pendingRecord();
  return {
    pending: [record],
    resolvingApprovalIds: new Set<string>(),
    resolveRefusalByApprovalId: new Map([[record.id, refusalForRecord]]),
    resolve: () => undefined,
  };
}

describe("the palette withdraws exactly where the card does", () => {
  it("offers neither a card action nor a palette row once the request is settled", () => {
    // A `settled` refusal means the request was answered elsewhere.
    renderCard(pendingRecord(), false, ALREADY_RESOLVED);

    expect(screen.queryByRole("toolbar", { name: "Answer this request" })).toBeNull();
    expect(approvalCommandRows(rowsFor(ALREADY_RESOLVED))).toEqual([]);
  });

  it("negative control: both keep offering where the same act is still admissible", () => {
    // Withdrawing on every refusal would strand a person on a retryable failure.
    renderCard(pendingRecord(), false, RETRYABLE);

    expect(screen.queryByRole("toolbar", { name: "Answer this request" })).not.toBeNull();
    expect(approvalCommandRows(rowsFor(RETRYABLE)).map((row) => row.kind)).toEqual([
      "approve",
      "reject",
    ]);
  });
});
