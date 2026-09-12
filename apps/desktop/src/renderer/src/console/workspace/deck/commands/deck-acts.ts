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
// EVERY ACT SAYS WHAT HAPPENED. The deck's focus is a ring rather than DOM focus, so
// a screen reader follows nothing when the focused pane changes: without a live-region
// line, cycling the deck is silent.
// The move act reuses `paneDropAnnouncement` — the drag path's own strings — rather
// than composing a second sentence for the same outcome, which is what keeps the
// keyboard path and the pointer path saying the same thing about the same move.
//
// A BOUNDARY IS NOT A REFUSAL. Moving the leftmost pane left changes nothing, and
// `paneDropAnnouncement` already carries that case in its assertive lane ("was not
// moved"). What IS refused is an act with no subject at all — no deck mounted, or a
// deck focusing nothing — and those two are said by the seat and by this file
// respectively, because only one of them is a fact about the deck.
//
// AND CLOSING A PANE THAT IS IN A WINDOW OF ITS OWN IS REFUSED, WITH THE REMEDY NAMED.
// A detached pane's slot is the placeholder its window returns INTO, so `layout.close`
// on one deletes the only thing that could receive the pane back: the shell goes on
// holding a window whose placeholder is gone, and its eventual return signal names a
// pane the deck no longer has. The pointer path already agrees — a detached slot
// renders `DetachedPaneBody`, which offers a focus control and a return control and NO
// close — so refusing here is what makes the keyboard and palette paths say the same
// thing that surface does, rather than inventing an act no control offers.
//
// REFUSING RATHER THAN CLOSING THE WINDOW FOR THEM. The other candidate was to route
// the close through the hand-off and take the window down with the slot, and it makes
// one keystroke destroy a separate top-level window that is not on screen and may be
// the surface the person is actually reading — an auxiliary window carries its own
// bridge instance and its own subscription, so it is a window in its own right and not
// a projection of this slot. The sentence names the control that exists ("Return it to
// the deck"), which is one press away in the slot the act was aimed at, and after it
// the close is the ordinary one.

import type { Announce } from "../../../primitives/index.js";
import type { DeckLayout } from "../model/deck-layout.js";
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
 * Whether one pane's body is currently in a window of its own.
 *
 * A READING passed in rather than the hand-off itself, and a predicate rather than the
 * detached set: this module decides what an act does and has no business holding the
 * plane that opens windows, and a caller handing over a set would be handing over a
 * value that is stale the moment it is captured.
 */
export type PaneDetachmentReading = (paneId: string) => boolean;

/**
 * What closing says about a pane whose body is in a window of its own.
 *
 * Composed from the kind and the placeholder's own control label, so the sentence
 * names a control the person can see rather than describing one. Exported because the
 * suite asserts the sentence a person hears and composing a second copy of it there
 * would assert the test's spelling rather than the console's.
 */
export function detachedPaneCloseRefusal(kind: string): string {
  return `The ${kind} pane is open in a window of its own. Return it to the deck before closing it.`;
}

/**
 * One reading over the ids a surface publishes.
 *
 * Built here rather than in the component, so the predicate's shape lives beside the
 * type that declares it. A scan rather than a `Set`: the question is asked once per
 * press over a list the deck's own restore cap bounds, and a set built per render to
 * answer it would be the more expensive of the two.
 */
export function paneDetachmentReadingFor(
  detachedPaneIds: readonly string[],
): PaneDetachmentReading {
  return (paneId) => detachedPaneIds.includes(paneId);
}

/**
 * Bind the five acts to one deck.
 *
 * A function of the layout and the announcer rather than a method on `DeckLayout`:
 * the store is what the deck IS and holds no opinion about live regions, and an
 * announcer reached from inside it would make every consumer of a layout a consumer
 * of the announcer too. The acts are the layer where a keystroke becomes a sentence.
 */
export function deckActsOn(
  layout: DeckLayout,
  announce: Announce,
  isPaneDetached: PaneDetachmentReading,
): DeckActs {
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
      if (isPaneDetached(closing.paneId)) {
        // Assertive, on `NO_FOCUSED_PANE_SENTENCE`'s lane rule: the thing the person
        // asked for did not happen, and the pane they were looking at is unchanged.
        announce(detachedPaneCloseRefusal(closing.kind), "assertive");
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
