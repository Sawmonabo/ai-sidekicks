// The line under the confirmation's acts: which control it may name, and what it says
// about the link once an answer has arrived.
//
// ITS OWN FILE, at the seam the card already has. `InviteConfirmation.test.tsx` is the
// card before an answer and `InviteConfirmation.outcomes.test.tsx` is the report after
// one; this asserts the one element that renders under BOTH and used to say the same
// sentence under each — a footnote about **Not now** printed beneath four answers that
// draw no **Not now** at all, and beneath a join that had already spent the link it
// promised still worked.
//
// THE PROPERTY WORTH THE MOST IS COHERENCE WITH THE CONTROL ROW, and it is asserted
// over every arm rather than over the ones that were wrong: a footnote naming a control
// is a claim about what is on screen, so the case below reads both and compares them.
// One arm added to the union with the wrong words fails here without anybody
// remembering to write a case for it.

import { cleanup } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { GrowthInviteOutcome } from "../../bridge/index.js";
import { renderCard } from "./invite-confirmation.test-support.js";
import {
  INVITED_SESSION_ID as INVITED_SESSION,
  PENDING_INVITE_REFERENCE as REFERENCE,
} from "./pending-invite.test-support.js";

const MEMBERSHIP = "019b7910-000a-7000-8000-000000000003";

/** The answer that spends the reference, which is the arm the old footnote lied about. */
const JOINED: GrowthInviteOutcome = {
  kind: "joined",
  reference: REFERENCE,
  sessionId: INVITED_SESSION,
  membershipId: MEMBERSHIP,
  role: "collaborator",
};

/**
 * Every state the card can carry an answer in, and the state before one.
 *
 * SEVEN ROWS OVER A SIX-ARM UNION: the seventh is `undefined`, which is not an arm and
 * is the state the whole footnote was written for. Listed here rather than derived from
 * a type, because a case needs a VALUE — and each row is one this suite renders, so a
 * row that stops being reachable fails rather than sitting unread.
 */
const EVERY_ANSWER: readonly { readonly label: string; readonly outcome?: GrowthInviteOutcome }[] =
  [
    { label: "nothing answered yet" },
    { label: "joined", outcome: JOINED },
    {
      label: "authentication-required",
      outcome: { kind: "authentication-required", reference: REFERENCE },
    },
    {
      label: "authentication-failed",
      outcome: {
        kind: "authentication-failed",
        reference: REFERENCE,
        detail: "The device code expired before it was entered.",
      },
    },
    {
      label: "refused",
      outcome: {
        kind: "refused",
        reference: REFERENCE,
        code: "invite.revoked",
        detail: "Invite has been revoked by the issuer",
      },
    },
    {
      label: "reference-invalid",
      outcome: { kind: "reference-invalid", reference: REFERENCE, reason: "expired" },
    },
    {
      label: "unavailable",
      outcome: { kind: "unavailable", reference: REFERENCE, retryable: true },
    },
  ];

/** The sentence a person reads under the acts, or a thrown explanation of its absence. */
function footnoteTextOf(root: HTMLElement): string {
  const footnote = root.querySelector(".meridian-invite-confirmation__footnote");
  if (footnote === null) {
    throw new Error("the card drew no footnote");
  }
  return footnote.textContent ?? "";
}

/** One arm's footnote, with the card taken back down so the next render stands alone. */
function footnoteFor(outcome: GrowthInviteOutcome | undefined): string {
  const text = footnoteTextOf(renderCard({ outcome }));
  cleanup();
  return text;
}

describe("the confirmation's footnote — it names the control that is drawn", () => {
  it.each(EVERY_ANSWER)("$label", ({ outcome }) => {
    // THE WHOLE FINDING, AS ONE COMPARISON. **Not now** is the card's own act row and
    // is drawn only while an answer is outstanding; every other arm is a report whose
    // act is **Done**. A footnote naming a control that is not there is guidance
    // contradicting the screen it sits on, which is what four of these seven arms did.
    const body = renderCard({ outcome });
    const drawsNotNow = body.querySelector(".meridian-invite-confirmation__dismiss") !== null;
    expect(footnoteTextOf(body).includes("Not now")).toBe(drawsNotNow);
  });

  it("gives every answer its own line", () => {
    // Exhaustive by the copy table's own `satisfies`, and DISTINCT by this: a table
    // that compiled with one arm copied into another would pass the comparison above
    // and still tell somebody whose sign-in failed what a join means.
    const footnotes = EVERY_ANSWER.map(({ outcome }) => footnoteFor(outcome));
    expect(footnotes.filter((line) => line.length === 0)).toStrictEqual([]);
    expect(new Set(footnotes).size).toBe(EVERY_ANSWER.length);
  });
});

describe("the confirmation's footnote — what it says about the link", () => {
  it("calls the link spent once an acceptance has consumed it", () => {
    // The sentence the card used to print here said the link still worked and that
    // **Not now** would put an unanswered invitation away — under a result announcing
    // that the invitation had been accepted and the membership was active.
    const footnote = footnoteFor(JOINED);
    expect(footnote).toContain("spent");
    expect(footnote).not.toContain("The link still works if you change your mind.");
  });

  it("keeps the link's future for the arms that still have one", () => {
    // Not one sentence for every answer: an acceptance that never reached the control
    // plane leaves the invitation untouched, and telling that reader their link was
    // spent would be the same defect written the other way round.
    expect(footnoteFor({ kind: "unavailable", reference: REFERENCE, retryable: true })).toContain(
      "The link still works if you change your mind.",
    );
  });

  it("negative control: with nothing answered yet it IS the pre-answer line", () => {
    // Without this the cases above would pass over a card whose footnote had been
    // emptied for every state, which reads as tidy and tells a person nothing about
    // the one act on screen that sends no answer at all.
    const body = renderCard();
    expect(footnoteTextOf(body)).toContain("The link still works if you change your mind.");
    expect(body.querySelector(".meridian-invite-confirmation__dismiss")).not.toBeNull();
  });
});

describe("the confirmation's footnote — what is behind the prompt", () => {
  it("counts what is waiting behind an unanswered one", () => {
    expect(footnoteFor(undefined)).not.toContain("behind it");
    expect(footnoteTextOf(renderCard({ waitingBehind: 2 }))).toContain(
      "There are 2 more invitations behind it.",
    );
  });

  it("agrees with a single one rather than printing a plural at it", () => {
    expect(footnoteTextOf(renderCard({ waitingBehind: 1 }))).toContain(
      "There is 1 more invitation behind it.",
    );
  });

  it("says the count is a floor while the queue's bound is holding arrivals back", () => {
    // `waitingBehind` counts the bounded queue and excludes what the bound turned away,
    // so an exact figure over it claims to be a total it is not.
    expect(footnoteTextOf(renderCard({ waitingBehind: 2, hasDeferredArrivals: true }))).toContain(
      "There are at least 2 more invitations behind it.",
    );
  });

  it("drops the count once an answer is on screen", () => {
    // What is behind this prompt is an argument for dealing with it now, and a settled
    // result poses no such question — the act there is **Done**, and the notice reports
    // the queue a press later.
    expect(footnoteTextOf(renderCard({ outcome: JOINED, waitingBehind: 2 }))).not.toContain(
      "behind it",
    );
  });
});
