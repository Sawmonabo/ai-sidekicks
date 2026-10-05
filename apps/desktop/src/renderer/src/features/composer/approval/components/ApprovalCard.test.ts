// What an answer sends: an answer the contract accepts, no second press while one is in flight, a
// remember opt-in that sends nothing until engaged, only on approve, and is absent where no
// standing allow is offered, a keyboard-walkable action row, and the requested resource shown in
// full before the person answers. The card and the palette rows withdraw together on a settled
// refusal. Payload assertions drive the real `onResolve`, so they check the wire request.

import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { refuse, type Refusal } from "#renderer/lib/refusal/refusal.js";
import {
  approvalCommandRows,
  type ApprovalCommandInput,
} from "../contributions/approval-commands.js";
import { isAcceptedAnswer, pendingRecord } from "../approval-record.test-support.js";
import { renderCard } from "./ApprovalCard.test-support.js";

/**
 * Engages the remember opt-in by clicking its label: the visible control is a `span` whose
 * state lives on a hidden native input inside the label.
 */
function engageRememberOptIn(): void {
  fireEvent.click(screen.getByRole("button", { name: "Remember this answer" }));
  fireEvent.click(screen.getByText("Remember my approval"));
}

describe("what an answer sends", () => {
  it("sends an answer the contract accepts, naming no scope of its own", () => {
    const requests = renderCard(pendingRecord());
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(requests).toHaveLength(1);
    expect(isAcceptedAnswer(requests[0])).toBe(true);
    expect(requests[0]).toStrictEqual({
      approvalRequestId: pendingRecord().id,
      decision: "approved",
      clientResolutionId: expect.any(String),
    });
  });

  it("mints a fresh client resolution id for every press", () => {
    // Two presses sharing an id would be two answers the daemon cannot tell apart.
    const requests = renderCard(pendingRecord());
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(requests[0]?.clientResolutionId).not.toBe(requests[1]?.clientResolutionId);
  });
});

describe("a press while the answer is in flight", () => {
  it("disables both actions while this record's call is in flight", () => {
    renderCard(pendingRecord(), true);
    const actions = screen.getByRole("toolbar", { name: "Answer this request" });
    for (const button of actions.querySelectorAll("button")) {
      expect(button.disabled).toBe(true);
    }
  });
});

describe("the remembered-rule opt-in", () => {
  it("omits `rememberedScope` entirely when the control was never engaged", () => {
    const requests = renderCard(pendingRecord());
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(requests[0] && "rememberedScope" in requests[0]).toBe(false);
  });

  it("sends an allow on the ask's own subject, at this session, once engaged", () => {
    const requests = renderCard(pendingRecord({ subject: "pnpm test" }));
    engageRememberOptIn();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(requests[0]?.rememberedScope).toStrictEqual({
      kind: "session",
      pattern: "pnpm test",
      sense: "allow",
    });
    expect(isAcceptedAnswer(requests[0])).toBe(true);
  });

  it("never sends a remembered scope on the reject path", () => {
    const requests = renderCard(pendingRecord());
    engageRememberOptIn();
    expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(requests[0]?.decision).toBe("rejected");
    expect(requests[0]?.rememberedScope).toBeUndefined();
  });

  it("is absent where the ask may not carry a standing allow", () => {
    renderCard(pendingRecord({ standingAllowOffered: false }));
    expect(screen.queryByRole("button", { name: "Remember this answer" })).toBeNull();
    // Negative control: the answers themselves stay.
    expect(screen.getByRole("button", { name: "Approve" })).not.toBeNull();
  });
});

describe("the action row is keyboard-walkable", () => {
  it("moves focus with an arrow and with a vim key, and suppresses the page scroll", () => {
    renderCard(pendingRecord());
    const actions = screen.getByRole("toolbar", { name: "Answer this request" });
    const approve = screen.getByRole("button", { name: "Approve" });
    const reject = screen.getByRole("button", { name: "Reject" });
    approve.focus();
    const arrowHandled = fireEvent.keyDown(actions, { key: "ArrowRight" });
    expect(document.activeElement).toBe(reject);
    // `fireEvent` answers false when a handler called `preventDefault`.
    expect(arrowHandled).toBe(false);
    fireEvent.keyDown(actions, { key: "h" });
    expect(document.activeElement).toBe(approve);
  });

  it("stops at each end rather than wrapping around", () => {
    renderCard(pendingRecord());
    const actions = screen.getByRole("toolbar", { name: "Answer this request" });
    const approve = screen.getByRole("button", { name: "Approve" });
    const reject = screen.getByRole("button", { name: "Reject" });
    approve.focus();
    fireEvent.keyDown(actions, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(approve);
    reject.focus();
    fireEvent.keyDown(actions, { key: "ArrowRight" });
    expect(document.activeElement).toBe(reject);
  });

  it("negative control: a key the row does not own moves nothing and is not suppressed", () => {
    renderCard(pendingRecord());
    const actions = screen.getByRole("toolbar", { name: "Answer this request" });
    const approve = screen.getByRole("button", { name: "Approve" });
    approve.focus();
    expect(fireEvent.keyDown(actions, { key: "ArrowDown" })).toBe(true);
    expect(document.activeElement).toBe(approve);
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
