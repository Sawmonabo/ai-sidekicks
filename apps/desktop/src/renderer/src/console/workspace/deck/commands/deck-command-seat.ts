// What the deck contributes to the palette, and how a press reaches the deck that is
// actually on screen.
//
// The five acts are `deck-acts.ts`'; this file is the seam between them and the
// window's command surface. The shape is `sidebar-command-seat.ts`' — a mounted-surface
// seat plus a contribution made at composition time — and it is deliberately that
// file's SHAPE rather than a use of it: both surfaces belong to this family, so
// nothing here crosses a family boundary and nothing here belongs in `seats/`.
//
// CONTRIBUTED AT COMPOSITION TIME, RESOLVED AT PRESS TIME. A command is built once per
// window, before any deck exists; the deck comes and goes with the route. So each row
// resolves the mounted deck when it runs, and an empty seat is a REFUSAL a person
// reads rather than a press that does nothing.
//
// WHY NO CHORD IS CLAIMED HERE, WHICH IS A DECISION AND NOT AN OMISSION.
//
// The deck already binds these five keystrokes on its own element — Alt+Arrow to
// cycle, Alt+Shift+Arrow to move, Alt+Backspace to close — and it guards them with
// `isEditableTarget`, the WIDE question: does the focused widget own its arrow keys?
// A find field, a combobox and a listbox all do, and `primitives/editable-target.ts`
// records that pairing as the fix for a measured defect, where typing in a pane's find
// field rearranged or closed the pane it was typed in.
//
// The window's binding table asks the NARROW question (`isTextEntryTarget`) and
// installs in the CAPTURE phase, and it consumes any press whose command RAN —
// `preventDefault` plus `stopPropagation`, on the reasoning that a press which ran
// something is the console's. Binding these same keystrokes there would therefore
// preempt the deck's handler and, inside a listbox or a combobox, run the deck act and
// eat the widget's arrow key. Moving the wide guard into the acts would not help: the
// act would decline and the table would consume the press anyway, because a command
// that ran is what the table measures. The only place the guard could live is a
// `when` clause, and the console's clause vocabulary is a closed set of route keys.
//
// So the keystrokes stay the deck's, where the wide guard is, and the palette rows are
// what this file adds: the same five acts, discoverable by name, reachable from
// anywhere in the session, and refusing out loud when there is no deck to act on.

import { useEffect } from "react";

import { refuse, type ConsoleRefusal } from "../../../core/index.js";
import {
  raiseConsoleActRefusal,
  type ConsoleCommand,
  type ConsoleCommandSurface,
} from "../../../palette/index.js";
import type { DeckActName, DeckActs } from "./deck-acts.js";

/**
 * What an act says when no deck is mounted in this window.
 *
 * One value rather than one per act: a person pressing a deck row from the settings
 * page needs to know the deck is not here, and naming which of the five they reached
 * for would answer a question they did not ask.
 */
export const DECK_NOT_MOUNTED_REFUSAL: ConsoleRefusal = refuse(
  "workspace",
  "workspace.no_mounted_deck",
  "No deck of panes is open in this window. Open a session and try again.",
);

/** What asking the seat to perform an act produced. */
export type DeckActOutcome =
  | { readonly status: "performed"; readonly act: DeckActName }
  | { readonly status: "refused"; readonly refusal: ConsoleRefusal };

/**
 * The mounted decks, in mount order.
 *
 * A class rather than a module-level array, and release is by IDENTITY rather than by
 * position: a StrictMode double mount and a route change must not leave the seat
 * holding a deck that is gone. The newest mount is the one a command acts on.
 */
export class MountedDeckSeat {
  readonly #mounted: DeckActs[] = [];

  public adopt(acts: DeckActs): () => void {
    this.#mounted.push(acts);
    return () => {
      const position = this.#mounted.lastIndexOf(acts);
      if (position >= 0) {
        this.#mounted.splice(position, 1);
      }
    };
  }

  public perform(act: DeckActName): DeckActOutcome {
    const newest = this.#mounted.at(-1);
    if (newest === undefined) {
      return { status: "refused", refusal: DECK_NOT_MOUNTED_REFUSAL };
    }
    newest[act]();
    return { status: "performed", act };
  }
}

/** This window's seat. Module scope is window scope: an auxiliary window is a process. */
export const mountedDeck: MountedDeckSeat = new MountedDeckSeat();

/** Adopt the seat for as long as this deck is mounted. */
export function useMountedDeck(acts: DeckActs, seat: MountedDeckSeat = mountedDeck): void {
  useEffect(() => seat.adopt(acts), [acts, seat]);
}

/**
 * The palette group these rows sit under.
 *
 * One binding rather than a literal per command: the group is also a secondary match
 * field, so two spellings would split the surface's rows across two categories.
 */
export const DECK_COMMAND_GROUP = "Panes";

/**
 * The `when` clause every command carries.
 *
 * Fail-closed by construction: the palette answers `false` for a key the context does
 * not carry, so a window with no session offers none of these rather than offering
 * acts with nothing to act on.
 */
const WHEN_SESSION_ACTIVE = "sessionActive";

/**
 * The owner string this contribution carries.
 *
 * The contribution door is owner-scoped, so composing twice — a hot reload, a second
 * test — replaces these rows instead of raising on their ids.
 */
export const DECK_COMMAND_OWNER = "workspace-deck";

/** Build the palette commands, given the acts each one performs. */
export function deckPaletteCommands(acts: DeckActs): readonly ConsoleCommand[] {
  return [
    {
      id: "deck.focusNextPane",
      title: "Focus the next pane",
      group: DECK_COMMAND_GROUP,
      when: WHEN_SESSION_ACTIVE,
      keywords: ["pane", "cycle", "right", "forward"],
      run: acts.focusNextPane,
    },
    {
      id: "deck.focusPreviousPane",
      title: "Focus the previous pane",
      group: DECK_COMMAND_GROUP,
      when: WHEN_SESSION_ACTIVE,
      keywords: ["pane", "cycle", "left", "back"],
      run: acts.focusPreviousPane,
    },
    {
      id: "deck.closePane",
      title: "Close the focused pane",
      group: DECK_COMMAND_GROUP,
      when: WHEN_SESSION_ACTIVE,
      keywords: ["pane", "dismiss", "hide"],
      run: acts.closeFocusedPane,
    },
    {
      id: "deck.movePaneLeft",
      title: "Move the focused pane left",
      group: DECK_COMMAND_GROUP,
      when: WHEN_SESSION_ACTIVE,
      keywords: ["pane", "reorder", "rearrange"],
      run: acts.moveFocusedPaneLeft,
    },
    {
      id: "deck.movePaneRight",
      title: "Move the focused pane right",
      group: DECK_COMMAND_GROUP,
      when: WHEN_SESSION_ACTIVE,
      keywords: ["pane", "reorder", "rearrange"],
      run: acts.moveFocusedPaneRight,
    },
  ];
}

/**
 * Contribute the deck's commands to a window.
 *
 * Takes the surface rather than reaching for the module-scope door, for
 * `registerLedgerCommands`' reason: a test contributes into a surface it owns, and an
 * auxiliary window could contribute a subset without a second code path.
 */
export function registerDeckCommands(
  surface: ConsoleCommandSurface,
  seat: MountedDeckSeat = mountedDeck,
): void {
  surface.contribute({
    owner: DECK_COMMAND_OWNER,
    commands: deckPaletteCommands(actsOnTheMountedDeck(seat)),
    keyBindings: [],
  });
}

/**
 * The act set every contributed command runs through.
 *
 * Written out rather than derived from a name list, so a SIXTH act added to `DeckActs`
 * fails to compile here instead of being contributed as a command that reaches the
 * mounted deck through nothing.
 */
function actsOnTheMountedDeck(seat: MountedDeckSeat): DeckActs {
  const perform = (act: DeckActName): void => {
    performOnMountedDeck(seat, act);
  };
  return {
    focusNextPane: () => {
      perform("focusNextPane");
    },
    focusPreviousPane: () => {
      perform("focusPreviousPane");
    },
    closeFocusedPane: () => {
      perform("closeFocusedPane");
    },
    moveFocusedPaneLeft: () => {
      perform("moveFocusedPaneLeft");
    },
    moveFocusedPaneRight: () => {
      perform("moveFocusedPaneRight");
    },
  };
}

/** Perform one act, and state the refusal where a person can see it. */
function performOnMountedDeck(seat: MountedDeckSeat, act: DeckActName): void {
  const outcome = seat.perform(act);
  if (outcome.status === "refused") {
    raiseConsoleActRefusal(outcome.refusal);
  }
}
