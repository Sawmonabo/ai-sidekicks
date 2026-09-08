// The invite confirmation after an answer: the six ways an attempt ends.
//
// The sibling of `InviteConfirmation.test.tsx`, split off it at the seam the card
// itself has — before an answer it asks a question and offers two acts, and after one
// it is a REPORT with an act row of its own. Every case here holds an outcome, and
// each asserts the pair a settled attempt has to get right: what the reading says,
// and which acts it offers. The act row is asserted WHOLE rather than by the absence
// of one control, because that is where the two ways of getting it wrong live — a
// retry offered against a refusal that will answer identically, and a settled prompt
// drawn with no way to clear it.
//
// The arms that produced no invitation at all are the third file in this set,
// `InviteConfirmation.previews.test.tsx`.

import { fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { GrowthInviteOutcome } from "../../bridge/index.js";
import { settle } from "../../core/settle.test-support.js";
import { control, outcomeActs, renderCard } from "./invite-confirmation.test-support.js";
import {
  INVITED_SESSION_ID as INVITED_SESSION,
  PENDING_INVITE_REFERENCE as REFERENCE,
} from "./pending-invite.test-support.js";

const MEMBERSHIP = "019b7910-000a-7000-8000-000000000002";

describe("the confirmation — the six ways an attempt ends", () => {
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

  it("offers a sign-in that is still running no act against the answer", () => {
    // Main is driving the ceremony and holding the reference across it, so there is
    // no answer yet: a retry would race the one that is coming, and acknowledging
    // would strand it against an invitation this window no longer holds. The report's
    // own row is therefore empty — the act that IS available there is the card's
    // dismissal, asserted in the case below.
    const body = outcomeCard({ kind: "authentication-required", reference: REFERENCE });
    expect(body.textContent ?? "").toContain("Sign in to finish joining.");
    expect(outcomeActs(body)).toEqual([]);
  });

  it("keeps the dismissal on screen while a sign-in is still running", () => {
    // The prompt used to render this arm with no control at all: the act row is
    // replaced by the report once an outcome exists, and this outcome is a step
    // rather than an end. A person who reopened the card met a stalled ceremony they
    // could look at and not back out of, while main still held the reference.
    const onDismiss = vi.fn();
    const body = outcomeCard(
      { kind: "authentication-required", reference: REFERENCE },
      { onDismiss },
    );
    const dismiss = control(body, "meridian-invite-confirmation__dismiss");
    expect(dismiss.disabled).toBe(false);
    // And not a second acceptance beside it: that would race the answer main is
    // already driving on this same reference.
    expect(body.querySelector(".meridian-invite-confirmation__confirm")).toBeNull();

    dismiss.click();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("releases the reference on Escape while a sign-in is still running", async () => {
    // THE DEFECT THIS PAIR CLOSES. Escape and the backdrop reached the local
    // acknowledgement here, which the lifecycle refuses on an answer still running —
    // so the card went away, no `dismissPending` was sent, and the ceremony and its
    // reference were left outstanding with no surface left to cancel them from.
    const onDismiss = vi.fn();
    const onAcknowledge = vi.fn();
    const body = outcomeCard(
      { kind: "authentication-required", reference: REFERENCE },
      { onDismiss, onAcknowledge },
    );
    await settle();
    fireEvent.keyDown(body.querySelector(".meridian-invite-confirmation") ?? body, {
      key: "Escape",
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onAcknowledge).not.toHaveBeenCalled();
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

  it("says the link is still worth following where only this window's hold lapsed", () => {
    // Terminal and about the HANDLE rather than the invitation, which is why the
    // reading turns on the one thing a person can act on next: the reference bound is
    // shorter than the invitation's own, so an expired hold says nothing about the
    // link in their message.
    const body = outcomeCard({
      kind: "reference-invalid",
      reference: REFERENCE,
      reason: "expired",
    });
    expect(body.textContent ?? "").toContain("Following the link again");
    expect(outcomeActs(body)).toEqual(["meridian-invite-outcome__acknowledge"]);
  });

  it("says the opposite where the invitation itself was already spent", () => {
    // The negative control for the reading above: one message for all three reasons
    // would tell somebody whose invitation is gone to follow the link again.
    const body = outcomeCard({
      kind: "reference-invalid",
      reference: REFERENCE,
      reason: "consumed",
    });
    const text = body.textContent ?? "";
    expect(text).toContain("already been accepted");
    expect(text).not.toContain("Following the link again");
    expect(outcomeActs(body)).toEqual(["meridian-invite-outcome__acknowledge"]);
  });

  it("offers the acceptance again when it could not be put, on the same reference", () => {
    // The one outcome arm carrying a recovery, and the wire's own `retryable` is what
    // says so — the surface derives no eligibility of its own. Pressing it puts the
    // SAME act again, so main decides whether the reference still resolves rather
    // than this card deciding it may.
    const onConfirm = vi.fn();
    const body = outcomeCard(
      { kind: "unavailable", reference: REFERENCE, retryable: true },
      { onConfirm },
    );
    expect(body.textContent ?? "").toContain("could not be sent");
    expect(outcomeActs(body)).toEqual([
      "meridian-invite-outcome__acknowledge",
      "meridian-invite-outcome__retry",
    ]);

    control(body, "meridian-invite-outcome__retry").click();
    expect(onConfirm).toHaveBeenCalledTimes(1);
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

  it("replaces both acts once an answer has ENDED", () => {
    // One question at a time: an accepting control beside a settled result would
    // invite a second act on a reference that is already spent, and a dismissal there
    // would release a handle main no longer holds. Asserted on a terminal arm, which
    // is the whole of what "spent" means — the running arm keeps its dismissal, and
    // the case above says so.
    const body = outcomeCard({
      kind: "joined",
      reference: REFERENCE,
      sessionId: INVITED_SESSION,
      membershipId: MEMBERSHIP,
      role: "collaborator",
    });
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
