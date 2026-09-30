// The card's hard claims: two answers, a remember opt-in that sends nothing until it is
// engaged and is absent where the ask may not carry a standing allow, an answer the
// contract accepts, and an action row a keyboard can walk.
//
// The claim that a refusal SETTLING the request withdraws both answers, and withdraws
// the pane's palette rows with them, is `ApprovalCard.settled.test.tsx` beside this
// file.
//
// The payload assertions drive the REAL `onResolve` the component calls, so what is
// checked is the request that would go on the wire rather than a re-derivation of
// it beside the component.

import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ACCENT_FILL_CLASS } from "../../accent-fill.js";
import { isAcceptedAnswer, pendingRecord } from "../approval-record.test-support.js";
import { renderCard } from "./approval-card.test-support.js";

/**
 * Engage the remember opt-in the way a person does — by clicking its label.
 *
 * The label rather than the `role="checkbox"` element: the visible control is a
 * `span` whose state lives on a hidden native input inside the same label, so a
 * click on the span alone is not the activation a pointer performs.
 */
function engageRememberOptIn(): void {
  fireEvent.click(screen.getByRole("button", { name: "Remember this answer" }));
  fireEvent.click(screen.getByText("Remember my approval"));
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
    renderCard(
      pendingRecord({
        state: "approved",
        decision: "approved",
        resolvedAt: "2026-01-01T13:31:00.000Z",
        approverId: "019b7a33-3300-7b01-8110-d1a4c1150561",
        effectiveScope: "session",
      }),
    );
    expect(screen.queryByRole("toolbar", { name: "Answer this request" })).toBeNull();
  });

  it("disables both actions while this record's call is in flight", () => {
    renderCard(pendingRecord(), true);
    const actions = screen.getByRole("toolbar", { name: "Answer this request" });
    for (const button of actions.querySelectorAll("button")) {
      expect(button.disabled).toBe(true);
    }
  });

  it("gives approve the filled accent and leaves reject quiet", () => {
    renderCard(pendingRecord());
    const actions = screen.getByRole("toolbar", { name: "Answer this request" });

    // The face comes from the primitives rather than from this pane's sheet, which
    // is what makes the ink measurable: `tokens/contrast.test.ts` measures
    // `accent-ink` against the fill, and a control painting its own accent is a
    // pairing that measurement never sees.
    expect(within(actions).getByRole("button", { name: "Approve" }).classList).toContain(
      ACCENT_FILL_CLASS,
    );

    // The negative control, and the design rule itself: one filled primary action per card. A
    // reject that also carried the fill would be a second — and reject is never
    // colored at all, because a rejection is the console working.
    expect(within(actions).getByRole("button", { name: "Reject" }).classList).not.toContain(
      ACCENT_FILL_CLASS,
    );
  });
});

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
    // The id is what tells the answering device from every other device showing the
    // card, so two presses sharing one would be two answers the daemon cannot tell apart.
    const requests = renderCard(pendingRecord());
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(requests[0]?.clientResolutionId).not.toBe(requests[1]?.clientResolutionId);
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
    // Negative control on the "no local formatter" rule: a string member renders
    // with no quotes added around it, so a JSON dump of the whole descriptor would
    // fail this assertion rather than pass it.
    expect(screen.queryByText(/^\{/u)).toBeNull();
  });

  it("renders a non-string member as its JSON form rather than dropping it", () => {
    renderCard(pendingRecord({ resourceDescriptor: { bytes: 4096, dryRun: false } }));
    fireEvent.click(screen.getByRole("button", { name: "What was asked for" }));
    expect(screen.getByText("4096")).not.toBeNull();
    expect(screen.getByText("false")).not.toBeNull();
  });

  it("says so when the descriptor carried no members at all", () => {
    renderCard(pendingRecord({ resourceDescriptor: {} }));
    fireEvent.click(screen.getByRole("button", { name: "What was asked for" }));
    expect(screen.getByText(/descriptor with nothing in it/u)).not.toBeNull();
  });
});

describe("the facts the reply requires", () => {
  it("names the run that raised the request", () => {
    renderCard(pendingRecord({ runId: "019b7a33-3300-740e-8110-d1a4c1150511" }));
    const facts = screen.getByText("Raised by run").closest("div");
    expect(facts).not.toBeNull();
    expect(
      within(facts ?? document.body).getByText("019b7a33-3300-740e-8110-d1a4c1150511"),
    ).not.toBeNull();
  });

  it("shows both instants as a clock reading that still carries the wire value", () => {
    renderCard(
      pendingRecord({
        createdAt: "2026-01-01T13:30:00.900Z",
        updatedAt: "2026-01-01T14:05:20.000Z",
      }),
    );
    // The formatted reading is what a person reads; the exact instant rides
    // `title`, because a formatted figure never hides the value the daemon sent.
    const created = screen.getByTitle("2026-01-01T13:30:00.900Z");
    const changed = screen.getByTitle("2026-01-01T14:05:20.000Z");
    expect(created.textContent).not.toBe("2026-01-01T13:30:00.900Z");
    expect(changed.textContent).not.toBe("");
  });
});
