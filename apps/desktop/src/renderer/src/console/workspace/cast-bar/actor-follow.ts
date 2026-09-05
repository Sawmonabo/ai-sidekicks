// What a cast chip press resolves to, before anything moves.
//
// Pressing a chip promises to follow the actor. Focusing a pane is only half of
// that, and in a deck holding one timeline it is none of it: the pane is already
// focused, so the press is a no-op. The other half is the ledger scrolling to that
// actor's newest row, and it can fail for two honest reasons — the participant has
// no row yet, or no ledger is mounted in this window to scroll.
//
// Those three outcomes are decided HERE, over the log, with no React and no seat, so
// the decision can be checked without rendering a workspace.
//
// AND THE DISPATCH LIVES HERE TOO, BESIDE THEM. Both halves of a press — the deck's
// focus and the ledger's scroll — read this module's own resolution and this module's
// own sentences, so a handler written in the surface would be the third place that
// has to agree about what following an actor means. The surface supplies the deck,
// the log, and the announcer; nothing about the act is decided there.

import { useCallback } from "react";

import { actorFollowHandler } from "../../seats/index.js";
import type { ConsoleSessionEvent, SessionStore } from "../../store/index.js";
import type { DeckLayout } from "../deck/deck-layout.js";

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
    if (event !== undefined && event.actorId === participantId) {
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

/**
 * Press a cast chip: focus the actor's pane, and bring their newest row into view.
 *
 * Both halves happen, and the second is not optional — in a deck holding one timeline
 * the first is a no-op, so a handler that stopped there would promise to follow
 * somebody and do nothing observable.
 *
 * The scroll rides the ledger's own chokepoint through the follow seat, never a
 * `scrollIntoView` call here. Each way it can fail says so: a participant with no
 * row, a row outside the window the ledger holds, and a window with no ledger mounted
 * are three different facts, and a press that quietly did nothing reported none of
 * them.
 */
export function useActorFollow(options: {
  readonly layout: DeckLayout;
  readonly sessionStore: SessionStore | undefined;
  readonly announce: (sentence: string) => void;
}): (participantId: string) => void {
  const { announce, layout, sessionStore } = options;
  return useCallback(
    (participantId: string) => {
      const panes = layout.snapshot().panes;
      const target =
        panes.find((pane) => pane.entity?.id === participantId) ??
        panes.find((pane) => pane.kind === "timeline");
      if (target !== undefined) {
        layout.focus(target.paneId);
      }

      const resolution = resolveActorFollow(sessionStore?.snapshot().timeline ?? [], participantId);
      if (resolution.outcome === "no-activity") {
        announce(ACTOR_FOLLOW_ANNOUNCEMENTS["no-activity"]);
        return;
      }
      const follow = actorFollowHandler();
      if (follow === undefined) {
        announce(ACTOR_FOLLOW_ANNOUNCEMENTS["no-ledger"]);
        return;
      }
      if (follow({ participantId, newestSequence: resolution.newestSequence }) !== "revealed") {
        announce(ACTOR_FOLLOW_ANNOUNCEMENTS["row-not-in-view"]);
      }
    },
    [announce, layout, sessionStore],
  );
}
