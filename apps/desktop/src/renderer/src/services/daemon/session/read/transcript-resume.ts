// Where a session's window opens on a read: the acknowledged position, else the log's floor,
// `earliest`. Pure: `base-state.ts` applies it to the cursor block `session.read` answered with.
//
// The cursors are relayed verbatim, so nothing here orders two of them: the only comparison is
// whether two strings the daemon issued are the same one.

import type { EventCursor } from "@ai-sidekicks/contracts/session/event-cursor";

/** What a read's cursor block says about where the window opens. */
export type TranscriptResumeDecision =
  | {
      /** A position was acknowledged above the floor, so rows may sit before it. */
      readonly outcome: "resume-acknowledged";
      /** The acknowledged position. */
      readonly fromCursor: EventCursor;
    }
  | {
      /** Nothing acknowledged above the floor: no surviving row sits before this position. */
      readonly outcome: "resume-earliest";
      /** The daemon's `earliest`. */
      readonly fromCursor: EventCursor;
    };

/** The two positions of a read's cursor block the resume rule takes. */
export interface TranscriptResumeCursors {
  readonly earliest: EventCursor;
  readonly acknowledged?: EventCursor | undefined;
}

/** Decide where one read's cursor block says the window opens: `acknowledged ?? earliest`. */
export function resolveTranscriptResume(
  cursors: TranscriptResumeCursors,
): TranscriptResumeDecision {
  // An acknowledged position equal to the floor has nothing before it either.
  return cursors.acknowledged === undefined || cursors.acknowledged === cursors.earliest
    ? { outcome: "resume-earliest", fromCursor: cursors.earliest }
    : { outcome: "resume-acknowledged", fromCursor: cursors.acknowledged };
}
