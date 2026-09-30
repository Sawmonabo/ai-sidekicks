// The skeleton rows a window draws while its first read is in flight.
//
// WHAT WAS MISSING. The store has carried the fact since it was written — `initialized`
// is false until a read response lands — and it never reached the pane. So a session
// whose first read was in flight rendered exactly like a session that had never had
// anything happen in it.
//
// A STANDING CAUSE ENDS THE SKELETON. `read-failed` is marked when the first read is
// refused or rejects, which leaves the store uninitialized and the cause standing, so
// drawing skeleton rows on `initialized` alone would leave `aria-busy` rows up for as
// long as the failure lasted over a read that had already ended. Only a window with no
// cause and no first read yet is still filling; the line under the session header says
// what the cause means for the person.

import { useSessionDegraded } from "@renderer/store/session/hooks/useSessionInitialized.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import { useTranscriptFirstReadSettled } from "../hooks/useTranscriptFirstReadSettled.js";

/**
 * How many skeleton rows a window that has not been read yet draws.
 *
 * Twelve is a screen of transcript at this density: enough that the shape on screen is
 * the shape the rows will take, and few enough that the first read replacing them is
 * one repaint rather than a page of skeleton rows collapsing.
 */
const SKELETON_ROW_COUNT = 12;

/**
 * The skeleton rows, minted once: twelve identical elements need twelve stable keys and
 * nothing else.
 */
const SKELETON_ROW_KEYS: readonly string[] = Object.freeze(
  Array.from({ length: SKELETON_ROW_COUNT }, (_unused, index) => `skeleton-row-${String(index)}`),
);

export interface TranscriptWindowSkeletonProps {
  readonly sessionStore: SessionStore;
}

/**
 * The skeleton rows, or nothing once the first read has landed or a cause stands.
 *
 * Read through the store's own selectors rather than off a snapshot, so this follows
 * a navigation that changes which session the pane is a log of.
 */
export function TranscriptWindowSkeleton(
  props: TranscriptWindowSkeletonProps,
): React.JSX.Element | null {
  // The same reading the viewport's empty arm takes, through the same hook: two
  // views speaking about one moment, and never from two selectors.
  const firstReadSettled = useTranscriptFirstReadSettled(props.sessionStore);
  const causeStands = useSessionDegraded(props.sessionStore);
  if (firstReadSettled || causeStands) {
    return null;
  }
  return (
    <div
      className="meridian-transcript-window-skeleton"
      role="status"
      aria-busy="true"
      aria-label="Reading this session's entries."
    >
      {SKELETON_ROW_KEYS.map((key) => (
        <span key={key} className="meridian-transcript-window-skeleton__row" aria-hidden="true" />
      ))}
    </div>
  );
}
