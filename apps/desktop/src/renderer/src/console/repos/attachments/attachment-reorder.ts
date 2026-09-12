// Where an attachment lands when a participant moves it, and what is said out loud
// when it does.
//
// OWN-BUILT, AND THAT IS THE ADOPTED LIBRARY'S OWN TERMS.
// `@atlaskit/pragmatic-drag-and-drop` is admitted for the drag GESTURE only, with the
// drop indicators, the keyboard path, and the live-region strings ours — the library
// publishes no keyboard drag by design and says the same outcome must be reachable
// through ordinary controls with announcements beside them. So the gesture is the
// library's and every answer about POSITION is here, in one pure module both paths
// call: a pointer drop and an arrow key that disagreed about where an attachment landed
// would be two orders for one list.
//
// POSITIONS ARE THE LEDGER'S, ZERO-BASED, AND SPOKEN ONE-BASED. `attachment-ingest-
// ledger.ts` keeps the participant's declared order in an explicit array and moves a
// member inside it, so a position here is an index into that array and nothing else.
// The announcement counts from one because that is how a person counts a list, and the
// conversion happens once, in the sentence, rather than at each caller.
//
// NOTHING HERE MUTATES. Every function is total over its inputs and returns a position
// or a sentence; the move itself is the ledger's single writer.

import type { AttachmentIngestEntry } from "./attachment-shapes.js";

/** Where this attachment sits in the declared order, or `undefined` if it is gone. */
export function attachmentPositionOf(
  entries: readonly AttachmentIngestEntry[],
  localId: string,
): number | undefined {
  const position = entries.findIndex((entry) => entry.declared.localId === localId);
  return position < 0 ? undefined : position;
}

/**
 * Where a keyboard move lands, or `undefined` when there is nowhere to go.
 *
 * REFUSING RATHER THAN CLAMPING at the ends, deliberately. A clamp would answer with
 * the position the attachment is already at, and the caller would then announce a move
 * that did not happen — the row at the top of the list saying "moved to position 1"
 * every time the key is pressed. `undefined` is what lets the caller stay silent.
 */
export function movedAttachmentPosition(
  fromPosition: number,
  offset: number,
  attachmentCount: number,
): number | undefined {
  const toPosition = fromPosition + offset;
  if (toPosition < 0 || toPosition >= attachmentCount) {
    return undefined;
  }
  return toPosition;
}

/**
 * What a participant is told after a move, through the console's one announcer.
 *
 * Names the attachment and both halves of the position, because a live region speaks
 * without the list in front of it: "moved" alone reports that something happened to
 * something, which is the announcement worth not making.
 */
export function attachmentReorderAnnouncement(
  attachmentName: string,
  toPosition: number,
  attachmentCount: number,
): string {
  return `${attachmentName} moved to position ${String(toPosition + 1)} of ${String(attachmentCount)}.`;
}

/** What the drag handle is called, so the gesture and the keyboard path share one name. */
export function attachmentReorderHandleLabel(
  attachmentName: string,
  atPosition: number,
  attachmentCount: number,
): string {
  return `Reorder ${attachmentName}, position ${String(atPosition + 1)} of ${String(attachmentCount)}. Drag, or press the up and down arrow keys.`;
}
