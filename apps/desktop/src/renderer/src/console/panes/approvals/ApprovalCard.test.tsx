// The card's four hard claims: two answers and no third, an expiry that is either
// verbatim or explicitly absent, a remember opt-in that sends nothing until it is
// engaged, and an action row a keyboard can walk.
//
// The payload assertions drive the REAL `onResolve` the component calls, so what is
// checked is the request that would go on the wire rather than a re-derivation of
// it beside the component.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ApprovalCard } from "./ApprovalCard.js";
import { DriverAskCard } from "./DriverAskCard.js";
import { type ApprovalRecord } from "./approval-records.js";
import { type ApprovalResolveRequest } from "./approvals-wire.js";

function pendingRecord(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    approvalRequestId: "approval-01",
    category: "file_write",
    state: "pending",
    requestedBy: "agent-implementer",
    requestedScope: "session",
    ...overrides,
  };
}

/**
 * Engage the remember opt-in the way a person does — by clicking its label.
 *
 * The label rather than the `role="checkbox"` element: the visible control is a
 * `span` whose state lives on a hidden native input inside the same label, so a
 * click on the span alone is not the activation a pointer performs.
 */
function engageRememberOptIn(): void {
  fireEvent.click(screen.getByRole("button", { name: "Remember this answer" }));
  fireEvent.click(screen.getByText("Remember my approval for this category"));
}

function renderCard(record: ApprovalRecord, isResolving = false): ApprovalResolveRequest[] {
  const requests: ApprovalResolveRequest[] = [];
  render(
    <ApprovalCard
      record={record}
      isResolving={isResolving}
      refusal={undefined}
      onResolve={(request) => requests.push(request)}
    />,
  );
  return requests;
}

describe("the two answers", () => {
  it("offers exactly Approve and Reject on a pending record", () => {
    renderCard(pendingRecord());
    const actions = screen.getByRole("toolbar", { name: "Answer this request" });
    const labels = [...actions.querySelectorAll("button")].map((button) => button.textContent);
    expect(labels).toStrictEqual(["Approve", "Reject"]);
  });

  it("offers no answer at all on a resolved record", () => {
    // Negative control for the case above: the toolbar has to be absent here, or
    // "exactly two" would be a claim about a row that is always rendered.
    renderCard(pendingRecord({ state: "approved" }));
    expect(screen.queryByRole("toolbar", { name: "Answer this request" })).toBeNull();
  });

  it("disables both actions while this record's call is in flight", () => {
    renderCard(pendingRecord(), true);
    const actions = screen.getByRole("toolbar", { name: "Answer this request" });
    for (const button of actions.querySelectorAll("button")) {
      expect(button.disabled).toBe(true);
    }
  });
});

describe("the remembered-scope opt-in", () => {
  it("omits `rememberedScope` entirely when the control was never engaged", () => {
    const requests = renderCard(pendingRecord());
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(requests).toHaveLength(1);
    expect(requests[0]).toStrictEqual({
      approvalRequestId: "approval-01",
      decision: "approved",
      effectiveScope: "session",
    });
    expect(requests[0] && "rememberedScope" in requests[0]).toBe(false);
  });

  it("never sends a remembered scope on the reject path", () => {
    const requests = renderCard(pendingRecord());
    engageRememberOptIn();
    expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(requests[0]?.decision).toBe("rejected");
    expect(requests[0]?.rememberedScope).toBeUndefined();
  });

  it("sends the ratified scope kind once the opt-in is engaged and approved", () => {
    const requests = renderCard(pendingRecord());
    engageRememberOptIn();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(requests[0]?.rememberedScope).toStrictEqual({ kind: "run" });
  });

  it("never widens the scope beyond what was requested", () => {
    const requests = renderCard(pendingRecord({ requestedScope: "run" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(requests[0]?.effectiveScope).toBe("run");
  });
});

describe("expiry is verbatim or explicitly absent", () => {
  it("shows the wire value exactly as sent", () => {
    renderCard(pendingRecord({ expiryAt: "2026-01-01T17:30:00.900Z" }));
    expect(screen.getByText("2026-01-01T17:30:00.900Z")).not.toBeNull();
  });

  it("says 'no expiry' rather than leaving the field blank", () => {
    renderCard(pendingRecord());
    expect(screen.getByText("No expiry")).not.toBeNull();
    // Negative control: the absent case must not also render a timestamp, or the
    // two arms would be indistinguishable to this assertion.
    expect(screen.queryByText("2026-01-01T17:30:00.900Z")).toBeNull();
  });
});

describe("the resolved quad", () => {
  it("renders all four members when the reply carried them", () => {
    renderCard(
      pendingRecord({
        state: "approved",
        resolvedAt: "2026-01-01T13:30:00.420Z",
        decision: "approved",
        approverId: "participant-you",
        effectiveScope: "run",
      }),
    );
    expect(screen.getByText("2026-01-01T13:30:00.420Z")).not.toBeNull();
    expect(screen.getByText("participant-you")).not.toBeNull();
  });

  it("says the record is incomplete rather than rendering it as whole", () => {
    renderCard(pendingRecord({ state: "rejected", decision: "rejected" }));
    expect(screen.getByText(/less than what happened/u)).not.toBeNull();
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
    // `fireEvent` answers false when a handler called `preventDefault`, which is
    // the page-scroll suppression this row promises.
    expect(arrowHandled).toBe(false);
    fireEvent.keyDown(actions, { key: "h" });
    expect(document.activeElement).toBe(approve);
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

describe("a permission-kind ask rides the same card", () => {
  it("shows the normalized input inline and names the expiry outcome", () => {
    const onResolve = vi.fn();
    render(
      <DriverAskCard
        record={pendingRecord({
          askId: "ask-11",
          resourceDescriptor: "git push --force origin main",
        })}
        isResolving={false}
        refusal={undefined}
        onResolve={onResolve}
      />,
    );
    expect(screen.getAllByText("git push --force origin main").length).toBeGreaterThan(0);
    expect(screen.getByText(/the run continues/u)).not.toBeNull();
    // It is the same card: the two answers are still the only two answers, and no
    // free-text answer arm exists on this surface.
    expect(screen.getByRole("toolbar", { name: "Answer this request" })).not.toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("says so when the reply carried no requested resource", () => {
    render(
      <DriverAskCard
        record={pendingRecord({ askId: "ask-12" })}
        isResolving={false}
        refusal={undefined}
        onResolve={vi.fn()}
      />,
    );
    expect(screen.getByText(/no requested resource/u)).not.toBeNull();
  });
});
