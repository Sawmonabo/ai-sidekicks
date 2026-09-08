// The line under the confirmation's acts, on each state the card can be in.
//
// IT USED TO BE ONE LINE FOR EVERY STATE, AND FOUR OF THEM WERE FALSE. The card
// carried a single footnote about **Not now** — that it tells nobody, and that the link
// still works if you change your mind — and printed it under every answer as well:
// under a join that had already spent the link, under a refusal, under a sign-in that
// failed, and under a handle that had stopped resolving. On those arms that control is
// not even drawn — `InviteOutcomeReport.tsx` draws **Done** instead — so the card named
// a control that was not there and a link that was gone, directly beside the result
// saying otherwise.
//
// A TABLE OVER THE OUTCOME UNION, so an arm added to it fails to compile here rather
// than reaching a person wearing another arm's words. That is the same rule the
// report's own switch keeps, for the same reason: this is copy, and copy is where a
// missing branch is invisible.
//
// WHICH ARMS MAY NAME **Not now** IS NOT DECIDED HERE. It is
// `isInviteAnswerOutstanding`, the lifecycle's own predicate — the one the card draws
// that control on — so the words and the control cannot disagree. Both arms it admits
// name it, and no other arm does.
//
// NO REMEDY IS RESTATED. Each answer's body above already carries what the wire said
// and what it means — the refusal's own code and sentence, the three handle readings,
// the two sign-in readings — so what a footnote adds is the one fact the body does not:
// what this window does next with the link a person was given.

import type { GrowthInviteOutcome } from "../../bridge/index.js";
import { waitingBehindSentence } from "./invite-queue-copy.js";
import { isInviteAnswerOutstanding, type PendingInviteSnapshot } from "./pending-invite-reading.js";

/**
 * What the card says under its acts, for the state the reading is in.
 *
 * One string rather than a shape the component assembles: every arm is a sentence
 * about the control that IS on screen, and a caller composing them could put an answer
 * beside a control belonging to a different one.
 */
export function invitationFootnote(snapshot: PendingInviteSnapshot): string {
  const { outcome } = snapshot;
  const answer =
    outcome === undefined ? UNANSWERED_FOOTNOTE : SETTLED_FOOTNOTE_BY_OUTCOME[outcome.kind];
  // THE QUEUE RIDES ONLY THE ARMS WHERE A DECISION IS STILL OUTSTANDING. What is
  // behind this prompt is an argument for dealing with it now, which is a question
  // only an unanswered prompt poses; once an answer is on screen the act is **Done**,
  // and what is waiting behind it is the notice's subject a press later.
  const behind = isInviteAnswerOutstanding(outcome) ? waitingBehindSentence(snapshot) : undefined;
  return behind === undefined ? answer : `${answer} ${behind}`;
}

/**
 * The footnote before anything has been dispatched at all.
 *
 * Both halves are facts a person cannot get anywhere else on this card: the plane has
 * no decline verb (`Spec-002 §Required Behavior` mints none), so putting the prompt
 * away tells nobody — and what it releases is this window's hold rather than the
 * invitation, so the link in their message is untouched.
 */
const UNANSWERED_FOOTNOTE =
  "Not now puts this away and tells nobody, because there is no decline to send. The link still works if you change your mind.";

/**
 * The footnote for each answer, exhaustive over the outcome union.
 *
 * Each line is what this window does NEXT with the link, which is the question the
 * unanswered footnote's second half answers and the one every arm below answers
 * differently. None of them restates a remedy the body above already carries.
 */
const SETTLED_FOOTNOTE_BY_OUTCOME = {
  // The acceptance was consumed, which is what makes the reference spent — the same
  // fact the `consumed` handle reading states from the other side. So the link is
  // finished rather than merely used, and saying it here is what the old footnote's
  // "the link still works" got exactly backwards.
  joined:
    "The link that brought you here is spent: an invitation is accepted once, and this one has been.",
  // The one answer that is a step rather than an end. Main is driving the ceremony and
  // holding the reference across it, so the card still draws **Not now** — and what
  // that press does here is leave the sign-in unfinished, not cancel anything this
  // window is in a position to cancel.
  "authentication-required":
    "Not now puts this away without finishing the sign-in. The link still works if you change your mind.",
  // Terminal, and its reference went with the failure — so there is nothing left here
  // to press again. The invitation itself never entered into it, which is why the way
  // back is the link rather than this card.
  "authentication-failed":
    "The invitation itself is untouched. Once you are signed in, following the link again starts over.",
  // The control plane answered about this invitation, and its own words are above with
  // what they mean for the link. What this adds is that the answer is THEIRS and that
  // this window sends nothing further — there is no appeal on this card.
  refused: "That answer is the control plane's own, and nothing further is sent from this window.",
  // A statement about the HANDLE and not about the invitation, which is the whole
  // reason the arm exists — and the reading above splits the three ways it can end.
  // Naming the subject is what keeps a person from reading a lapsed hold as a lapsed
  // invitation.
  "reference-invalid":
    "This window's hold on the invitation is what ended here; what that means for the link is above.",
  // Nothing was decided, so main is still holding the reference and **Done** releases
  // it — the one arm where the close act is the wire's dismissal under a different
  // label. Both halves of the unanswered footnote are therefore still true, and this
  // says them about the control that is actually drawn.
  unavailable:
    "Done lets this window's hold go and tells nobody. The link still works if you change your mind.",
} as const satisfies Record<GrowthInviteOutcome["kind"], string>;
