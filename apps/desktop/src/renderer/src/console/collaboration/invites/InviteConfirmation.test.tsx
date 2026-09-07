// The invite confirmation: what it shows, what it will not show, and the one thing it
// will not do on its own.
//
// The property worth the most is that nothing accepts without a press — and, since the
// reference lifecycle landed, that what the card holds is a REFERENCE and never a
// credential. Both are asserted here, and the second is asserted against the shape as
// well as against the render: there is no token member to print.
//
// EVERY CASE HERE HOLDS AN INVITATION. The two arms that produced none — a preview the
// control plane refused and one it could not answer at all — are
// `InviteConfirmation.previews.test.tsx`, because what is asserted about them is a
// different subject: not what the card says about an invitation, but what it offers
// when there is no reference to spend on anything.

import { fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { GrowthInviteOutcome } from "../../bridge/index.js";
import { settle } from "../../core/settle.test-support.js";
import { formatClockTime, formatDateTime } from "../../primitives/index.js";
import { control, outcomeActs, renderCard } from "./invite-confirmation.test-support.js";
import {
  INVITED_SESSION_ID as INVITED_SESSION,
  PENDING_INVITE_REFERENCE as REFERENCE,
  pendingInvite as invite,
} from "./pending-invite.test-support.js";

const MEMBERSHIP = "019b7910-000a-7000-8000-000000000002";

describe("the confirmation — when there is nothing to confirm", () => {
  it("renders nothing at all", () => {
    const body = renderCard({ invite: undefined });
    expect(body.querySelector(".meridian-invite-confirmation")).toBeNull();
  });

  it("stays closed until it is opened, even with an invitation waiting", () => {
    // The arrival draws a notice; the card is a press later. A dialog that opened
    // itself would take the screen from whatever was being done.
    const body = renderCard({}, { open: false });
    expect(body.querySelector(".meridian-invite-confirmation")).toBeNull();
  });

  it("negative control: opened, with an invitation, it is on screen", () => {
    expect(renderCard().querySelector(".meridian-invite-confirmation")).not.toBeNull();
  });
});

describe("the confirmation — what it says about the invitation", () => {
  it("falls back to the session's own identity when the preview carried no name", () => {
    expect(renderCard().textContent ?? "").toContain(INVITED_SESSION);
  });

  it("prefers the name when there is one", () => {
    const body = renderCard({ invite: invite({ sessionName: "Relay sweep" }) });
    expect(body.textContent ?? "").toContain("Relay sweep");
  });

  it("never renders a raw inviter identifier in place of a display name", () => {
    const body = renderCard();
    expect(body.textContent ?? "").toContain("Not named");
    expect(body.textContent ?? "").not.toContain("participant-");
  });

  it("negative control: a display name that IS present renders", () => {
    const body = renderCard({ invite: invite({ inviterDisplayName: "Priya Raman" }) });
    expect(body.textContent ?? "").toContain("Priya Raman");
    expect(body.textContent ?? "").not.toContain("Not named");
  });

  it("names the day the invitation stops working, not just the minute", () => {
    // This surface carries no date divider, so a clock-only reading would say
    // "10:05" about an instant a week away.
    const expiresAt = "2026-01-08T10:05:00.000Z";
    const body = renderCard({ invite: invite({ expiresAt }) });
    expect(body.querySelector(`[title="${expiresAt}"]`)?.textContent).toBe(
      formatDateTime(expiresAt),
    );
  });

  it("negative control: the clock-only reading of two different days is one string", () => {
    expect(formatClockTime("2026-01-12T10:05:00.000Z")).toBe(
      formatClockTime("2026-01-08T10:05:00.000Z"),
    );
  });

  it("prints the join mode the invitation grants", () => {
    expect(renderCard({ invite: invite({ joinMode: "viewer" }) }).textContent ?? "").toContain(
      "viewer",
    );
  });

  it("never prints the opaque reference", () => {
    // It addresses a confined credential. It is passed to the acts and rendered
    // nowhere — and there is no token member on this shape at all, which is what
    // makes the confinement a property of the type rather than of this render.
    expect(renderCard().textContent ?? "").not.toContain(REFERENCE);
  });

  it("says how many more are waiting behind this one", () => {
    expect(renderCard({ waitingBehind: 2 }).textContent ?? "").toContain("2 more invitations");
  });
});

describe("the confirmation — the two acts before an answer", () => {
  it("accepts on a press and on nothing else", () => {
    const onConfirm = vi.fn();
    const body = renderCard({}, { onConfirm });
    expect(onConfirm).not.toHaveBeenCalled();
    control(body, "meridian-invite-confirmation__confirm").click();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("closes the accepting control while an act is unsettled, and says it is busy", () => {
    const body = renderCard({ actInFlight: "confirm" });
    const confirm = control(body, "meridian-invite-confirmation__confirm");
    expect(confirm.disabled).toBe(true);
    expect(confirm.getAttribute("aria-busy")).toBe("true");
  });

  it("negative control: with nothing in flight the accepting control is open", () => {
    expect(control(renderCard(), "meridian-invite-confirmation__confirm").disabled).toBe(false);
  });

  it("releases the reference from the control that puts the card away", () => {
    // **Not now** is not a local hide. `Plan-023` T-023r-6-3 routes every dismissal
    // to `invite.dismissPending`; a close that only hid the card would leave the
    // reference queued in main and the notice would come straight back.
    const onDismiss = vi.fn();
    const body = renderCard({}, { onDismiss });
    control(body, "meridian-invite-confirmation__dismiss").click();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("offers one dismissal and not two names for it", () => {
    // A **Discard it** control used to sit beside **Not now**, doing the same act
    // under a louder name. One act, one control.
    const body = renderCard();
    expect(body.querySelector(".meridian-invite-confirmation__discard")).toBeNull();
    expect(body.querySelectorAll(".meridian-invite-confirmation__dismiss")).toHaveLength(1);
  });

  it("closes the dismissal while an act on the same reference is unsettled", () => {
    // The lifecycle refuses a dismissal under its own one-at-a-time latch, so an open
    // control here would be a press that silently does nothing.
    expect(
      control(renderCard({ actInFlight: "confirm" }), "meridian-invite-confirmation__dismiss")
        .disabled,
    ).toBe(true);
  });

  it("releases the reference on Escape", async () => {
    // The library's own dismissal, and the case exists because it is a CHOICE:
    // `AlertDialog` next door deliberately has none, and an invitation is the other
    // kind of question — one a person may walk away from without answering. What it
    // reaches is the same act the control reaches, exactly once.
    const onDismiss = vi.fn();
    const body = renderCard({}, { onDismiss });
    await settle();
    fireEvent.keyDown(body.querySelector(".meridian-invite-confirmation") ?? body, {
      key: "Escape",
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("releases the reference on a press outside it", async () => {
    const onDismiss = vi.fn();
    const body = renderCard({}, { onDismiss });
    await settle();
    const backdrop = body.querySelector(".meridian-invite-confirmation__backdrop");
    if (backdrop === null) {
      throw new Error("no backdrop");
    }
    fireEvent.pointerDown(backdrop);
    fireEvent.mouseUp(backdrop);
    fireEvent.click(backdrop);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("negative control: a press INSIDE it releases nothing", async () => {
    // Without this the case above would pass over a dialog that closed on any press
    // at all, which would spend the invitation the moment a person read it.
    const onDismiss = vi.fn();
    const body = renderCard({}, { onDismiss });
    await settle();
    const facts = body.querySelector(".meridian-invite-confirmation__facts");
    if (facts === null) {
      throw new Error("no facts");
    }
    fireEvent.pointerDown(facts);
    fireEvent.mouseUp(facts);
    fireEvent.click(facts);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("puts the dismissal under the initial focus, and never the acceptance", async () => {
    // Acceptance is a deliberate act, and an auto-focused accepting control plus a
    // stray return key is acceptance by accident on a credential nobody can reissue.
    const body = renderCard();
    await settle();
    expect(body.ownerDocument.activeElement).toBe(
      control(body, "meridian-invite-confirmation__dismiss"),
    );
    expect(body.querySelector("[autofocus]")).toBeNull();
  });

  it("renders an act the port refused where the act was pressed", () => {
    const body = renderCard({
      actRefusal: { code: "wire-unregistered", detail: "Nobody asked.", origin: "growth-port" },
    });
    expect(body.textContent ?? "").toContain("wire-unregistered");
  });
});

describe("the confirmation — the four ways an attempt ends", () => {
  function outcomeCard(
    outcome: GrowthInviteOutcome,
    acts: Parameters<typeof renderCard>[1] = {},
  ): HTMLElement {
    return renderCard({ outcome }, acts);
  }

  it("names what the acceptance activated when it worked", () => {
    const body = outcomeCard({
      kind: "joined",
      reference: REFERENCE,
      sessionId: INVITED_SESSION,
      membershipId: MEMBERSHIP,
      role: "collaborator",
    });
    const text = body.textContent ?? "";
    expect(text).toContain("You are in.");
    // The navigation is the hosting lifecycle's, on the outcome EVENT — this reading
    // offers no control of its own that would be a second way into the session.
    expect(text).toContain(MEMBERSHIP);
    expect(text).toContain("collaborator");
    expect(outcomeActs(body)).toEqual(["meridian-invite-outcome__acknowledge"]);
  });

  it("prints the wire's own code and message beside what they mean here", () => {
    const body = outcomeCard({
      kind: "refused",
      reference: REFERENCE,
      code: "invite.expired",
      detail: "Invite has expired and can no longer be accepted",
    });
    const text = body.textContent ?? "";
    expect(text).toContain("invite.expired");
    expect(text).toContain("Invite has expired and can no longer be accepted");
    expect(text).toContain("Ask whoever sent it for a fresh link");
  });

  it("offers no second attempt against a refusal", () => {
    // Pressing again sends the identical request to the identical answer, so a
    // retry here would be a control that cannot work.
    const body = outcomeCard({
      kind: "refused",
      reference: REFERENCE,
      code: "invite.revoked",
      detail: "Invite has been revoked by the issuer",
    });
    expect(outcomeActs(body)).toEqual(["meridian-invite-outcome__acknowledge"]);
  });

  it("leaves a sign-in that is still running with nothing to press", () => {
    // Main is driving the ceremony and holding the reference across it, so there is
    // no answer yet: a retry would race the one that is coming, and putting it away
    // would strand it against an invitation this window no longer holds.
    const body = outcomeCard({ kind: "authentication-required", reference: REFERENCE });
    expect(body.textContent ?? "").toContain("Sign in to finish joining.");
    expect(outcomeActs(body)).toEqual([]);
  });

  it("tells a sign-in that failed apart from one that was never attempted", () => {
    const body = outcomeCard({
      kind: "authentication-failed",
      reference: REFERENCE,
      detail: "The device code expired before it was entered.",
    });
    const text = body.textContent ?? "";
    expect(text).toContain("Signing in did not finish.");
    expect(text).toContain("The device code expired before it was entered.");
    // Terminal: its reference went with the failure, so there is nothing left to
    // send and the only act is putting the answer away.
    expect(outcomeActs(body)).toEqual(["meridian-invite-outcome__acknowledge"]);
  });

  it("negative control: an answer that ended still draws its act row", () => {
    // Without this the case above would pass over a report that drew no acts at all,
    // which would leave every settled prompt on screen with no way to clear it.
    const body = outcomeCard({
      kind: "joined",
      reference: REFERENCE,
      sessionId: INVITED_SESSION,
      membershipId: MEMBERSHIP,
      role: "collaborator",
    });
    expect(outcomeActs(body)).toEqual(["meridian-invite-outcome__acknowledge"]);
  });

  it("puts a settled result away only on a press", () => {
    const onAcknowledge = vi.fn();
    const body = outcomeCard(
      {
        kind: "refused",
        reference: REFERENCE,
        code: "invite.not_found",
        detail: "Invite does not exist",
      },
      { onAcknowledge },
    );
    expect(onAcknowledge).not.toHaveBeenCalled();
    control(body, "meridian-invite-outcome__acknowledge").click();
    expect(onAcknowledge).toHaveBeenCalledTimes(1);
  });

  it("replaces both acts once an answer has arrived", () => {
    // One question at a time: an accepting control beside a settled result would
    // invite a second act on a reference that is already spent.
    const body = outcomeCard({ kind: "authentication-required", reference: REFERENCE });
    expect(body.querySelector(".meridian-invite-confirmation__confirm")).toBeNull();
    expect(body.querySelector(".meridian-invite-confirmation__dismiss")).toBeNull();
  });

  it("acknowledges rather than dismisses once the reference is spent", async () => {
    // A `dismissPending` here would be an act against a handle main no longer holds:
    // the reference was consumed at acceptance, so what closing the card means after
    // an answer is acknowledgement.
    const onDismiss = vi.fn();
    const onAcknowledge = vi.fn();
    const body = outcomeCard(
      {
        kind: "joined",
        reference: REFERENCE,
        sessionId: INVITED_SESSION,
        membershipId: MEMBERSHIP,
        role: "collaborator",
      },
      { onDismiss, onAcknowledge },
    );
    await settle();
    fireEvent.keyDown(body.querySelector(".meridian-invite-confirmation") ?? body, {
      key: "Escape",
    });
    expect(onAcknowledge).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

describe("the confirmation — what a person reads", () => {
  it("names no governance work anywhere", () => {
    expect(renderCard().textContent ?? "").not.toMatch(/\b(?:Spec|Plan|ADR|BL|CP|T-023)-?\d/u);
  });

  it("labels the dialog for assistive technology", () => {
    expect(renderCard().querySelector('[aria-label="Confirm this invitation"]')).not.toBeNull();
  });
});
