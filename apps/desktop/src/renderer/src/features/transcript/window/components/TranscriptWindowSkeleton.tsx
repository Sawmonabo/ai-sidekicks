// Skeleton rows for a window whose first read is in flight. A standing degraded cause ends the
// skeleton: a failed read leaves the store uninitialized, so `initialized` alone would keep
// `aria-busy` rows up over a read that already ended.

import "./TranscriptWindowSkeleton.css";

import { useSessionDegraded } from "#renderer/store/session/hooks/useSessionInitialized.js";
import { type SessionStore } from "#renderer/store/session/store.js";
import { useTranscriptFirstReadSettled } from "../hooks/useTranscriptFirstReadSettled.js";

/** A screenful at transcript density, so the first read replaces the rows in one repaint. */
const SKELETON_ROW_COUNT = 12;

const SKELETON_ROW_KEYS: readonly string[] = Object.freeze(
  Array.from({ length: SKELETON_ROW_COUNT }, (_unused, index) => `skeleton-row-${String(index)}`),
);

/** The session whose first read the skeleton follows. */
export interface TranscriptWindowSkeletonProps {
  readonly sessionStore: SessionStore;
}

/**
 * Skeleton rows while the first read is in flight; nothing once it has landed or a degraded
 * cause stands. Reads through the store's selectors so it follows a change of session.
 */
export function TranscriptWindowSkeleton(
  props: TranscriptWindowSkeletonProps,
): React.JSX.Element | null {
  // Same reading as the feed's empty window, so the two never speak about one moment differently.
  const firstReadSettled = useTranscriptFirstReadSettled(props.sessionStore);
  const causeStands = useSessionDegraded(props.sessionStore);
  if (firstReadSettled || causeStands) {
    return null;
  }
  return (
    // Drawn at once, so it is not read out; its words are hidden text a reader reaches by browsing.
    <div className="meridian-transcript-window-skeleton" aria-busy="true">
      <span className="meridian-visually-hidden">{SKELETON_WORDS}</span>
      {SKELETON_ROW_KEYS.map((key) => (
        <span key={key} className="meridian-transcript-window-skeleton__row" aria-hidden="true" />
      ))}
    </div>
  );
}

/** What the skeleton holds for a reader while the first read is in flight. */
const SKELETON_WORDS = "Loading…";
