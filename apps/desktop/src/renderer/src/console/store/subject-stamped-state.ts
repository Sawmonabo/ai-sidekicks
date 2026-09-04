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
// The fix is that the state is STAMPED with what it belongs to and the disagreement is
// settled DURING the render that brings a new one — React's own adjustment pattern:
// setting state during a render discards that pass and re-renders with the corrected
// value, so nothing claiming the wrong subject is ever committed.
//
// WHAT A READ BELONGS TO IS A PAIR, AND NOT THE SUBJECT ALONE. A read is put THROUGH
// something — the growth port its caller was handed — and answered ABOUT a subject, so
// two reads through different sources are two different reads even under one subject
// id. The stamp was the subject alone, and the source moving under it is not a
// hypothetical: the fixture's scenario switch mints a new bridge and hands the same
// session id back, so the first render under the new source committed the PREVIOUS
// source's entities and only the passive effect afterwards took them down. Stamping
// the pair is what makes that frame unreachable, and it retires the reset each of the
// three callers used to state in its own effect — one rule, in one place, instead of
// the same rule written three times and enforced one commit late.
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
 * What a held read belongs to: the source it was put through, and its subject.
 *
 * The source is compared by identity, which is exactly the claim: a port is minted
 * once per bridge, so an unchanged reference is the same seam and a new one is a
 * different daemon's worth of answers wearing the same session id.
 */
interface StampedReadAddress {
  readonly source: object;
  readonly subject: string | undefined;
}

/** Where a read stands the moment it is addressed at `subject`, and nowhere else. */
function subjectReadStart(subject: string | undefined): SubjectReadStart {
  return subject === undefined ? { status: "unasked" } : { status: "reading" };
}

/**
 * Hold one read's state, stamped with the source and subject it is about.
 *
 * The returned state is always about the pair passed on this render: on the render
 * that brings a new source or a new subject it is `reading` (or `unasked`, where the
 * new subject is none), never the previous pair's answer, and never an absence claim
 * about a question already asked.
 *
 * The setter is the caller's own: this helper decides what a read STARTS as and
 * nothing about how it settles.
 */
export function useSubjectStampedRead<TSettled>(
  source: object,
  subject: string | undefined,
): readonly [SubjectStampedRead<TSettled>, Dispatch<SetStateAction<SubjectStampedRead<TSettled>>>] {
  const [state, setState] = useState<SubjectStampedRead<TSettled>>(() => subjectReadStart(subject));
  // What the state on screen belongs to, adjusted DURING the render that brings a new
  // pair. React discards this pass and re-renders with the corrected value, so the
  // stale pair is never committed and no effect has to race the paint.
  const [address, setAddress] = useState<StampedReadAddress>(() => ({ source, subject }));
  if (address.source !== source || address.subject !== subject) {
    setAddress({ source, subject });
    setState(subjectReadStart(subject));
  }
  return [state, setState];
}
