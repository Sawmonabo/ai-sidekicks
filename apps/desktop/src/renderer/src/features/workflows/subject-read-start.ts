// The seed rule for a subject-keyed workflow read: what the read starts as, given the subject
// this render is addressed at. The holder (`lib/subject-scoped/subject-scoped-holder.ts`) calls
// it as `initial` when the subject changes; state and stale settlements are the holder's.
// It sits at the feature root because the definitions list, definition detail, runs list and run
// page all seed with it.

/**
 * The two facts a subject-keyed read starts from. `unasked` means nobody could put the question,
 * which a list may draw as an empty region; `reading` means the question is out. Painting one
 * while the other is true is the conflation the absence grammar exists to prevent.
 */
export type SubjectReadStart = { readonly status: "unasked" } | { readonly status: "reading" };

/** One subject-keyed read's whole state: the two start arms plus the caller's settled arms. */
export type SubjectRead<TSettled> = SubjectReadStart | TSettled;

/** Where a read stands the moment it is addressed at `subject`. */
export function subjectReadStart(subject: string | undefined): SubjectReadStart {
  return subject === undefined ? { status: "unasked" } : { status: "reading" };
}
