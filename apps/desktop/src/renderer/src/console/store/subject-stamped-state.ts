// A read that is ABOUT something, held so it can never be read about something else.
//
// Three surfaces put the same shape of question — the definitions a session can see,
// the runs a session holds, one run's snapshot — and each of them is addressed at a
// subject that can change under a mounted caller. Every one of them held its state in
// a plain `useState` seeded `unasked` and moved it to `reading` from an effect, which
// is wrong twice over:
//
//   • THE FIRST COMMITTED RENDER CLAIMED NOBODY HAD ASKED. An effect runs after the
//     commit, so a caller with a subject in hand painted one frame of `unasked` before
//     the request it had already issued. The surfaces draw that as served-looking
//     empty groups and as "has not been read in this window" — an absence claim about
//     the daemon, exposed to assistive technology, while the read was in flight.
//   • A SUBJECT CHANGE LEFT THE PREVIOUS SUBJECT'S ANSWER ON SCREEN. Between the
//     render that brought subject B and the effect that reset the state, A's served
//     rows or A's phases were renderable under B's address, and nothing about them
//     said so.
//
// The fix is that the state is STAMPED with the subject it belongs to and the
// disagreement is settled DURING the render that brings the new one — React's own
// adjustment pattern: setting state during a render discards that pass and re-renders
// with the corrected value, so nothing claiming the wrong subject is ever committed.
//
// WHY THIS IS ONE HELPER AND NOT THREE COPIES. The rule is one rule — a subject in
// hand is a question being put, no subject is a question that cannot be — and the
// three hooks disagreed about it in three different ways before it was written down
// once. `apps/desktop/AGENTS.md` hoists a helper on its second use; this is its third.
//
// WHY IT LIVES IN `store/` RATHER THAN IN `core/`. `core/` imports no React by its
// own rule, and this is a hook. `store/` is the lowest family in the console's DAG
// that holds React state bindings, and both consumers — the `workflows/` view family
// and the run pane — sit above it.

import { useState, type Dispatch, type SetStateAction } from "react";

/**
 * The two facts a subject-keyed read starts from, before anything has answered.
 *
 * They are two and not one because the next move differs: `unasked` says nobody could
 * put the question, which a surface may legitimately draw as an empty region, and
 * `reading` says the question is out. Collapsing them is the conflation the console's
 * absence grammar exists to prevent — and painting the first while the second is true
 * is the same conflation with a frame's delay in front of it.
 */
export type SubjectReadStart = { readonly status: "unasked" } | { readonly status: "reading" };

/**
 * One subject-keyed read's whole state: the two it starts from, plus what settles it.
 *
 * The settled arms are the caller's, because what an answer looks like is the caller's
 * business and what an unanswered read looks like is not.
 */
export type SubjectStampedRead<TSettled> = SubjectReadStart | TSettled;

/**
 * Where a read stands the moment it is addressed at `subject`, and nowhere else.
 *
 * Exported beside the hook because a caller's effect re-issues the read when its PORT
 * changes under an unchanged subject — a bridge swapped underneath, which the fixture
 * scenario switch does — and that reset states the same rule. Stating it twice is how
 * the two would come apart.
 */
export function subjectReadStart(subject: string | undefined): SubjectReadStart {
  return subject === undefined ? { status: "unasked" } : { status: "reading" };
}

/**
 * Hold one subject-keyed read's state, stamped with the subject it is about.
 *
 * The returned state is always about the subject passed on this render: on the render
 * that brings a new one it is `reading` (or `unasked`, where the new subject is none),
 * never the previous subject's answer, and never an absence claim about a question
 * already asked.
 *
 * The setter is the caller's own: this helper decides what a read STARTS as and
 * nothing about how it settles.
 */
export function useSubjectStampedRead<TSettled>(
  subject: string | undefined,
): readonly [SubjectStampedRead<TSettled>, Dispatch<SetStateAction<SubjectStampedRead<TSettled>>>] {
  const [state, setState] = useState<SubjectStampedRead<TSettled>>(() => subjectReadStart(subject));
  // The subject the state on screen belongs to, adjusted DURING the render that brings
  // a new one. React discards this pass and re-renders with the corrected value, so
  // the stale pair is never committed and no effect has to race the paint.
  const [stampedSubject, setStampedSubject] = useState<string | undefined>(subject);
  if (stampedSubject !== subject) {
    setStampedSubject(subject);
    setState(subjectReadStart(subject));
  }
  return [state, setState];
}
