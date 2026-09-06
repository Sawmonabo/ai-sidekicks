// What the attachment carrier says when it is holding nothing.
//
// A MODULE OF ITS OWN because two of the section's parts render the same absence —
// the list and the collapsed summary — and a sentence declared in one of them and
// imported by the other would make one part's private copy the other's contract, and
// close a cycle between the section and its own row.

/** What a carrier holding nothing says, in both shapes. */
export const EMPTY_CARRIER_TITLE = "No file has been attached in this session.";

export const EMPTY_CARRIER_DETAIL =
  "Attaching is deliberate — a file is read, sent in bounded chunks, and minted as an artifact only once the daemon has all of its bytes. What this session has already produced is the artifact pane's own read.";
