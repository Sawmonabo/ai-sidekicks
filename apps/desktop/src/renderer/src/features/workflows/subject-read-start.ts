// Where a subject-keyed read STANDS before anything has answered it.
//
// The seed rule and nothing else: the workflow reads put the same shape of question —
// the definitions a session can see, one definition's detail, the runs a session
// holds, one run's snapshot — and
// each is addressed at a subject that can change under a mounted caller. What holds
// their state across that change, and what a settlement arriving after it may do, is
// `lib/subject-scoped/subject-scoped-holder.ts` and its React half
// `hooks/subject-scoped/useSubjectScopedResource.ts`. This module answers only
// the question the holder hands back to its caller: given the subject this render is
// addressed at, what does the read start as?
//
// WHY IT IS A FUNCTION THE CALLER PASSES RATHER THAN A HOLDER OF ITS OWN. The holder's
// `initial` is read exactly when the subject changes, which is the moment this rule
// applies, and the rule is about the SUBJECT rather than about storage. Keeping it here
// as a pure function is what let the storage and the stamp fold into the shared holder
// while the `unasked` / `reading` distinction stayed where it is understood.
//
// WHY IT SITS AT THE WORKFLOWS FEATURE'S ROOT. The definitions list, the definition
// detail, the runs list and the run page all seed with it, and the feature's root is
// the one folder above all four.

/**
 * The two facts a subject-keyed read starts from, before anything has answered.
 *
 * They are two and not one because the next move differs: `unasked` says nobody could
 * put the question, which a list may legitimately draw as an empty region, and
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
export type SubjectRead<TSettled> = SubjectReadStart | TSettled;

/** Where a read stands the moment it is addressed at `subject`, and nowhere else. */
export function subjectReadStart(subject: string | undefined): SubjectReadStart {
  return subject === undefined ? { status: "unasked" } : { status: "reading" };
}
