// What a cast chip press resolves to, before anything moves.
//
// Pressing a chip promises to follow the actor. Focusing a pane is only half of
// that, and in a deck holding one timeline it is none of it: the pane is already
// focused, so the press is a no-op. The other half is the ledger scrolling to that
// actor's newest row, and it can fail for two honest reasons — the participant has
// no row yet, or no ledger is mounted in this window to scroll.
//
// Those three outcomes are decided HERE, over the log, with no React and no seat, so
// the decision can be checked without rendering a workspace. The dispatch and the
// sentence a person hears are the surface's.

import type { ConsoleSessionEvent } from "../store/index.js";

/** What pressing a chip resolves to. */
export type ActorFollowResolution =
  | { readonly outcome: "follow"; readonly newestSequence: number }
  | { readonly outcome: "no-activity" };

/**
 * The participant's newest row in the session log, or the honest absence.
 *
 * Walked backwards and stopped at the first match: the log is ordered oldest-first,
 * so the newest attributed row is the last one, and a full pass would cost the whole
 * session to learn something the tail already says.
 */
export function resolveActorFollow(
  timeline: readonly ConsoleSessionEvent[],
  participantId: string,
): ActorFollowResolution {
  for (let position = timeline.length - 1; position >= 0; position -= 1) {
    const event = timeline[position];
    if (event !== undefined && event.actorParticipantId === participantId) {
      return { outcome: "follow", newestSequence: event.sequence };
    }
  }
  return { outcome: "no-activity" };
}

/**
 * What a person hears when a press could not bring a row into view.
 *
 * Declared here beside the resolution so the two absences are one closed set with one
 * sentence each, rather than string literals written at the call site where nothing
 * would notice a fourth one appearing.
 */
export const ACTOR_FOLLOW_ANNOUNCEMENTS = {
  "no-activity": "That participant has nothing in this session's log yet.",
  "row-not-in-view": "That row is not in the part of the log this window is showing.",
  "no-ledger": "The session log is not open in this window.",
} as const;
