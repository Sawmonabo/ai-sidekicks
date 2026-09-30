// The replay a window with a hole in what it received asks for.
//
// It says nothing on screen. The one line under the session header says the window is
// catching up, and nothing else repeats it: no second notice for the missing entries
// and no note of how the repair is made. What this adds is the repair itself, a replay
// from the position this window kept; where no read has acknowledged a position, the
// whole-window re-read the store performs anyway is the repair.
//
// IT NEEDS TWO THINGS THAT ARE IN HAND IN EXACTLY ONE PLACE: the store, for the hole, and
// the registry, for the position a read acknowledged. The session screen body is handed
// everything BUT the registry, so its place is beside `ResumeRefusalBanner`, which sits
// above that body for the same reason.

import { useSessionStore } from "@renderer/store/session/hooks/useOpenSessionStore.js";
import { useTimelineResume } from "@renderer/store/session/hooks/useSessionInitialized.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import { type SessionStoreRegistry } from "@renderer/store/session/session-store-registry.js";
import { type SessionStoreState } from "@renderer/store/session/session-state.js";
import type { TimelineSubscribeCall } from "@renderer/services/daemon/session-reads.js";
import { useTranscriptGapFill } from "../hooks/useTranscriptGapFill.js";

/** The stores the hole and the kept position are read from, and the call that asks. */
export interface TranscriptGapFillProps {
  readonly registry: SessionStoreRegistry;
  readonly sessionStore: SessionStore;
  /** Puts the replay ask. */
  readonly fillGap: TimelineSubscribeCall;
}

/** Puts the replay ask for the hole standing now, and renders nothing. */
export function TranscriptGapFill(props: TranscriptGapFillProps): null {
  const { sessionId } = props.sessionStore;
  const missingFromSequence = useSessionStore(props.sessionStore, readOldestMissingSequence);
  const resume = useTimelineResume(props.registry, sessionId);
  useTranscriptGapFill(
    {
      sessionId,
      missingFromSequence,
      // The one position this console legitimately holds. Every other arm of the resume
      // decision names none — a restart because nothing was ever acknowledged, a refusal
      // because the daemon could not resolve what this console sent — and neither is a
      // position to replay from. The refusal itself is already on screen above, rendered
      // by the banner that owns that reading.
      keptCursor: resume?.outcome === "resume" ? resume.fromCursor : undefined,
    },
    props.fillGap,
  );
  return null;
}

/**
 * The first log position of the oldest hole standing, or nothing where none is.
 *
 * A number rather than the gap row itself, and the narrowing is what keeps this a
 * stable selector: the store's `gaps` array re-identifies on every transition that
 * touches it, so a selector answering the row would re-render this on transitions that
 * changed nothing about the hole. The oldest is `gaps[0]` — the store records them
 * oldest first — and a replay opens after one position and runs forward, so the oldest
 * is the only one worth asking from.
 */
function readOldestMissingSequence(state: SessionStoreState): number | undefined {
  return state.gaps[0]?.fromSequence;
}
