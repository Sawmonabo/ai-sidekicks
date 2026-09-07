// The card over a deep link that produced no invitation at all.
//
// ITS OWN FILE because the two readings are two subjects. Everything next door is
// about an invitation the console HOLDS — what it says about it, what the two acts
// spend, how the four outcomes settle — and every case here is about the two arms that
// minted no reference, where there is nothing to confirm, nothing to release, and one
// act that puts the preview again.
//
// The defect the block exists for: those two arms reached the window, were held by the
// lifecycle, and were rendered by nothing — so an expired link looked exactly like a
// link nobody followed, and the retry the `unavailable` arm carries the handle for was
// offered by no control on any screen.

import { fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { settle } from "../../core/settle.test-support.js";
import {
  control,
  outcomeActs,
  renderCard,
  type InviteConfirmationActs,
} from "./invite-confirmation.test-support.js";
import type { PendingInviteSnapshot } from "./pending-invite.js";
import { refusedPreview, unavailablePreview } from "./pending-invite.test-support.js";

describe("the confirmation — a preview that produced no invitation", () => {
  /** The card over one of the two preview failures, with no invitation in the reading. */
  function failureCard(
    previewFailure: NonNullable<PendingInviteSnapshot["previewFailure"]>,
    overrides: Partial<PendingInviteSnapshot> = {},
    acts: InviteConfirmationActs = {},
  ): HTMLElement {
    return renderCard(
      {
        invite: undefined,
        previewFailure,
        canRetry: previewFailure.status === "unavailable",
        ...overrides,
      },
      acts,
    );
  }

  it("prints the wire's own code and message for a refusal, beside what they mean here", () => {
    const body = failureCard(refusedPreview());
    const text = body.textContent ?? "";
    expect(text).toContain("invite.expired");
    expect(text).toContain("Invite has expired and can no longer be accepted");
    expect(text).toContain("Ask whoever sent it for a fresh link");
  });

  it("offers a refused preview one act, and it is the one that sends nothing", () => {
    // Pressing again puts the identical request to the identical answer, and there is
    // no reference for a dismissal to release either — so the only act is the close.
    expect(outcomeActs(failureCard(refusedPreview()))).toEqual([
      "meridian-invite-outcome__acknowledge",
    ]);
  });

  it("names the outage on a preview that could not be put, and never calls it a refusal", () => {
    const text = failureCard(unavailablePreview()).textContent ?? "";
    expect(text).toContain("could not reach the control plane");
    expect(text).not.toContain("invite.expired");
  });

  it("offers the retry beside the close on the one arm that admits it", () => {
    expect(outcomeActs(failureCard(unavailablePreview()))).toEqual([
      "meridian-invite-outcome__acknowledge",
      "meridian-invite-outcome__retry",
    ]);
  });

  it("negative control: the retry is absent from the arm the reading says cannot take one", () => {
    // Without this the case above would pass over a card that drew the retry on every
    // preview failure, which would send an attempt handle that arm does not carry.
    expect(
      failureCard(refusedPreview()).querySelector(".meridian-invite-outcome__retry"),
    ).toBeNull();
  });

  it("puts the preview again on a press, and on nothing else", () => {
    const onRetry = vi.fn();
    const body = failureCard(unavailablePreview(), {}, { onRetry });
    expect(onRetry).not.toHaveBeenCalled();
    control(body, "meridian-invite-outcome__retry").click();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("closes both controls while an act on this head is unsettled, and says which is busy", () => {
    // The lifecycle refuses a second act under its own one-at-a-time latch, so an open
    // control here would be a press that silently does nothing — and acknowledging
    // mid-flight would strand the answer against a head this window no longer holds.
    const body = failureCard(unavailablePreview(), { actInFlight: "retry" });
    const retry = control(body, "meridian-invite-outcome__retry");
    expect(retry.disabled).toBe(true);
    expect(retry.getAttribute("aria-busy")).toBe("true");
    expect(control(body, "meridian-invite-outcome__acknowledge").disabled).toBe(true);
  });

  it("negative control: with nothing in flight both controls are open", () => {
    const body = failureCard(unavailablePreview());
    expect(control(body, "meridian-invite-outcome__retry").disabled).toBe(false);
    expect(control(body, "meridian-invite-outcome__acknowledge").disabled).toBe(false);
  });

  it("offers neither act that spends a reference, because there is none to spend", () => {
    const body = failureCard(unavailablePreview());
    expect(body.querySelector(".meridian-invite-confirmation__confirm")).toBeNull();
    expect(body.querySelector(".meridian-invite-confirmation__dismiss")).toBeNull();
  });

  it("renders a retry the port refused, where it was pressed", () => {
    const body = failureCard(unavailablePreview(), {
      actRefusal: { code: "wire-unregistered", detail: "Nobody asked.", origin: "growth-port" },
    });
    expect(body.textContent ?? "").toContain("wire-unregistered");
  });

  it("acknowledges rather than dismisses on Escape, because nothing is held to release", () => {
    // A `dismissPending` here would be an act against a handle main never minted: a
    // preview that produced no invitation produced no reference either.
    const onDismiss = vi.fn();
    const onAcknowledge = vi.fn();
    const body = failureCard(refusedPreview(), {}, { onDismiss, onAcknowledge });
    fireEvent.keyDown(body.querySelector(".meridian-invite-confirmation") ?? body, {
      key: "Escape",
    });
    expect(onAcknowledge).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("puts the close under the initial focus, and never the retry", async () => {
    const body = failureCard(unavailablePreview());
    await settle();
    expect(body.ownerDocument.activeElement).toBe(
      control(body, "meridian-invite-outcome__acknowledge"),
    );
  });

  it("labels the dialog for what it is, rather than as a confirmation", () => {
    // Nothing on this arm can be confirmed, so a label promising one would announce a
    // control the card does not have.
    const body = failureCard(refusedPreview());
    expect(body.querySelector('[aria-label="This invitation did not open"]')).not.toBeNull();
    expect(body.querySelector('[aria-label="Confirm this invitation"]')).toBeNull();
  });
});
