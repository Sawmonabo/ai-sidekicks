// The five things a person can ask of the deck without a pointer, and what each of
// them says out loud.
//
// ONE IMPLEMENTATION, TWO CALLERS. The deck's own key handler (`Deck.tsx`) dispatches
// these when focus is inside the deck, and the palette dispatches the same five from
// anywhere in the session through the seat beside this file. They were one handler
// and no palette rows, which meant the acts were reachable only with focus already in
// the deck and were absent from the one surface a person searches when they do not
// know a chord — and a second copy written for the palette would have been two answers
// to what "move the pane" does.
//
// EVERY ACT SAYS WHAT HAPPENED. `Spec-023 §Console Design (Meridian)` puts the deck's
// focus on a ring rather than on DOM focus, so a screen reader follows nothing when
// the focused pane changes: without a live-region line, cycling the deck is silent.
// The move act reuses `paneDropAnnouncement` — the drag path's own strings — rather
// than composing a second sentence for the same outcome, which is what keeps the
// keyboard path and the pointer path saying the same thing about the same move.
//
// A BOUNDARY IS NOT A REFUSAL. Moving the leftmost pane left changes nothing, and
// `paneDropAnnouncement` already carries that case in its assertive lane ("was not
// moved"). What IS refused is an act with no subject at all — no deck mounted, or a
// deck focusing nothing — and those two are said by the seat and by this file
// respectively, because only one of them is a fact about the deck.

import type { Announce } from "../../../primitives/index.js";
import type { DeckLayout } from "../deck-layout.js";
import { paneDropAnnouncement } from "../pane-drag.js";

/**
 * The acts a mounted deck offers. One niladic call per act, so the name is the whole
 * request — the shape `SidebarActs` takes, for the same reason: the palette contributes
 * these at composition time, long before a deck exists to act on.
 */
export interface DeckActs {
  readonly focusNextPane: () => void;
  readonly focusPreviousPane: () => void;
  readonly closeFocusedPane: () => void;
  readonly moveFocusedPaneLeft: () => void;
  readonly moveFocusedPaneRight: () => void;
}

/** One act, by name. Derived from the interface, so the two cannot drift. */
export type DeckActName = keyof DeckActs;

/** What an act says when the deck it reached is focusing nothing. */
export const NO_FOCUSED_PANE_SENTENCE = "No pane is focused in the deck.";

/**
 * Bind the five acts to one deck.
 *
 * A function of the layout and the announcer rather than a method on `DeckLayout`:
 * the store is what the deck IS and holds no opinion about live regions, and an
 * announcer reached from inside it would make every consumer of a layout a consumer
 * of the announcer too. The acts are the layer where a keystroke becomes a sentence.
 */
export function deckActsOn(layout: DeckLayout, announce: Announce): DeckActs {
  const focusStep = (step: 1 | -1): void => {
    const before = layout.snapshot().focusedPaneId;
    layout.focusAdjacent(step);
    const { panes, focusedPaneId } = layout.snapshot();
    const position = panes.findIndex((pane) => pane.paneId === focusedPaneId);
    const focused = panes[position];
    if (focused === undefined) {
      // An empty deck. It already says so on screen — `Deck.tsx` renders the
      // nothing — so a second sentence would be the console repeating itself.
      return;
    }
    if (focusedPaneId === before) {
      // A one-pane deck, where cycling lands where it started. Said in the assertive
      // lane for `paneDropAnnouncement`'s reason: "the thing you tried did not
      // happen" is exactly what a cycle with nowhere to go is.
      announce(`The ${focused.kind} pane is the only pane open.`, "assertive");
      return;
    }
    announce(
      `Focused the ${focused.kind} pane, position ${String(position + 1)} of ${String(panes.length)}.`,
      "polite",
    );
  };

  const moveStep = (step: 1 | -1): void => {
    const before = layout.snapshot().panes;
    const fromPosition = before.findIndex(
      (pane) => pane.paneId === layout.snapshot().focusedPaneId,
    );
    const moved = before[fromPosition];
    if (moved === undefined) {
      announce(NO_FOCUSED_PANE_SENTENCE, "assertive");
      return;
    }
    layout.movePane(moved.paneId, step);
    const after = layout.snapshot().panes;
    const announcement = paneDropAnnouncement(
      moved.kind,
      fromPosition,
      after.findIndex((pane) => pane.paneId === moved.paneId),
      after.length,
    );
    announce(announcement.message, announcement.politeness);
  };

  return {
    focusNextPane: () => {
      focusStep(1);
    },
    focusPreviousPane: () => {
      focusStep(-1);
    },
    closeFocusedPane: () => {
      const { panes, focusedPaneId } = layout.snapshot();
      const closing = panes.find((pane) => pane.paneId === focusedPaneId);
      if (closing === undefined) {
        announce(NO_FOCUSED_PANE_SENTENCE, "assertive");
        return;
      }
      layout.close(closing.paneId);
      announce(`Closed the ${closing.kind} pane.`, "polite");
    },
    moveFocusedPaneLeft: () => {
      moveStep(-1);
    },
    moveFocusedPaneRight: () => {
      moveStep(1);
    },
  };
}
