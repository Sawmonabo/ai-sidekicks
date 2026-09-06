// The invite confirmation: what it shows, what it will not show, and the one thing it
// will not do on its own.
//
// The property worth the most is that nothing accepts without a press — and, since the
// reference lifecycle landed, that what the card holds is a REFERENCE and never a
// credential. Both are asserted here, and the second is asserted against the shape as
// well as against the render: there is no token member to print.

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { GrowthInviteOutcome } from "../../bridge/index.js";
import { settle } from "../../core/settle.test-support.js";
import { formatClockTime, formatDateTime } from "../../primitives/index.js";
import { InviteConfirmation } from "./InviteConfirmation.js";
import type { PendingInviteSnapshot } from "./pending-invite.js";
import {
  INVITED_SESSION_ID as INVITED_SESSION,
  PENDING_INVITE_REFERENCE as REFERENCE,
  pendingInvite as invite,
  pendingInviteSnapshot as snapshot,
} from "./pending-invite.test-support.js";

const MEMBERSHIP = "019b7910-000a-7000-8000-000000000002";

/** The card, portalled into the test's own container so a case can query it. */
function renderCard(
  overrides: Partial<PendingInviteSnapshot> = {},
  acts: Partial<{
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onConfirm: () => void;
    onRetry: () => void;
    onDiscard: () => void;
    onAcknowledge: () => void;
  }> = {},
): HTMLElement {
  const { container } = render(
    <InviteConfirmation
      open={acts.open ?? true}
      onOpenChange={acts.onOpenChange ?? (() => undefined)}
      snapshot={snapshot(overrides)}
      onConfirm={acts.onConfirm ?? (() => undefined)}
      onRetry={acts.onRetry ?? (() => undefined)}
      onDiscard={acts.onDiscard ?? (() => undefined)}
      onAcknowledge={acts.onAcknowledge ?? (() => undefined)}
      overlayContainer={document.body}
    />,
  );
  return container.ownerDocument.body;
}

function control(root: HTMLElement, className: string): HTMLButtonElement {
  const found = root.querySelector<HTMLButtonElement>(`.${className}`);
  if (found === null) {
    throw new Error(`no ${className}`);
  }
  return found;
}

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

describe("the confirmation — the three acts before an answer", () => {
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

  it("puts the card away without releasing the invitation", () => {
    // **Not now** is a local hide. Nobody is told, and the invitation is still
    // waiting — `Spec-002 §Required Behavior` mints no decline verb to send.
    const onOpenChange = vi.fn();
    const onDiscard = vi.fn();
    const body = renderCard({}, { onOpenChange, onDiscard });
    control(body, "meridian-invite-confirmation__dismiss").click();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onDiscard).not.toHaveBeenCalled();
  });

  it("releases the invitation only through the control that says so", () => {
    const onDiscard = vi.fn();
    const body = renderCard({}, { onDiscard });
    control(body, "meridian-invite-confirmation__discard").click();
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape", async () => {
    // The library's own dismissal, and the case exists because it is a CHOICE:
    // `AlertDialog` next door deliberately has none, and an invitation is the other
    // kind of question — one a person may walk away from without answering.
    const onOpenChange = vi.fn();
    const body = renderCard({}, { onOpenChange });
    await settle();
    fireEvent.keyDown(body.querySelector(".meridian-invite-confirmation") ?? body, {
      key: "Escape",
    });
    // The first argument only: the dismissal carries the event and its reason after
    // it, and asserting the whole call would be asserting the library's signature.
    expect(onOpenChange.mock.calls.at(0)?.at(0)).toBe(false);
  });

  it("closes on a press outside it", async () => {
    const onOpenChange = vi.fn();
    const body = renderCard({}, { onOpenChange });
    await settle();
    const backdrop = body.querySelector(".meridian-invite-confirmation__backdrop");
    if (backdrop === null) {
      throw new Error("no backdrop");
    }
    fireEvent.pointerDown(backdrop);
    fireEvent.mouseUp(backdrop);
    fireEvent.click(backdrop);
    expect(onOpenChange.mock.calls.at(0)?.at(0)).toBe(false);
  });

  it("negative control: a press INSIDE it closes nothing", async () => {
    // Without this the case above would pass over a dialog that closed on any press
    // at all, which would put the card away the moment a person read it.
    const onOpenChange = vi.fn();
    const body = renderCard({}, { onOpenChange });
    await settle();
    const facts = body.querySelector(".meridian-invite-confirmation__facts");
    if (facts === null) {
      throw new Error("no facts");
    }
    fireEvent.pointerDown(facts);
    fireEvent.mouseUp(facts);
    fireEvent.click(facts);
    expect(onOpenChange).not.toHaveBeenCalled();
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
    expect(text).toContain(MEMBERSHIP);
    expect(text).toContain("collaborator");
    expect(body.querySelector(".meridian-invite-outcome__retry")).toBeNull();
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
    expect(body.querySelector(".meridian-invite-outcome__retry")).toBeNull();
  });

  it("offers one where authentication is what is missing", () => {
    const onRetry = vi.fn();
    const body = outcomeCard(
      { kind: "authentication-required", reference: REFERENCE },
      { onRetry },
    );
    expect(body.textContent ?? "").toContain("Sign in to finish joining.");
    control(body, "meridian-invite-outcome__retry").click();
    expect(onRetry).toHaveBeenCalledTimes(1);
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
    expect(body.querySelector(".meridian-invite-outcome__retry")).not.toBeNull();
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

  it("replaces the three acts once an answer has arrived", () => {
    // One question at a time: an accepting control beside a settled result would
    // invite a second act on a reference that is already spent.
    const body = outcomeCard({ kind: "authentication-required", reference: REFERENCE });
    expect(body.querySelector(".meridian-invite-confirmation__confirm")).toBeNull();
    expect(body.querySelector(".meridian-invite-confirmation__discard")).toBeNull();
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
