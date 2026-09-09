// The frame's own command vocabulary: its `when` scoping, its rail table, its chords.
//
// IN `palette/` AND NOT IN `frame/`, WHERE IT WAS WRITTEN. Every input here is this
// family's or below it — `ConsoleCommand` and `KeyBinding` are declared next door,
// `ConsoleWhenClauseKey` is the vocabulary in `console-commands.ts` beside this file,
// and `RAIL_DESTINATIONS` is `routing/`, two families down. A command IS a registry
// entry and a chord IS a key-binding-table row, so the lowest family that owns these
// inputs is the one that declares what they are made of.
//
// It sat in `frame/` while the frame was its only reader, and that stopped being true:
// a settings page renders the bound chords, and a view family cannot reach `frame/`.
// Not by deep import, which the cross-family rule refuses, and not through the frame's
// door either — `frame/index.ts` re-exports `ConsoleRoot`, which composes every view
// family through `families.ts`, so the edge back closes a measured cycle:
//
//   families.ts → <family>/index.ts → frame/index.ts → ConsoleRoot.tsx → families.ts
//
// THE NAMES STAY `Frame*` BECAUSE THEY ARE STILL TRUE. These are the shapes the FRAME's
// own contributions take and the chords the FRAME binds; the declaration moved, the
// authorship did not. Renaming them `Console*` would say the console at large
// contributes them, which would make them indistinguishable from the registry-wide
// vocabulary in `console-commands.ts` that they are deliberately narrower than.
//
// THE REGISTRY IS NOT HERE. `console-commands.ts` beside this file holds it, along with
// the `when`-clause vocabulary the types below are scoped to.
//
// The frame's OWN commands are not registered at module scope either. They close over
// a live store, which module scope cannot reach, so `ConsoleRoot` registers them in an
// effect and removes them on unmount.

import { COMPOSER_FOCUS_CHORD } from "../../../../../shared/composer-chord.js";
import type { Unsubscribe } from "../../core/index.js";
import { RAIL_DESTINATIONS, type RailDestination } from "../../routing/index.js";
import {
  consoleFamilyKeyBindings,
  subscribeToConsoleFamilyContributions,
  type ConsoleWhenClauseKey,
} from "./console-commands.js";
import type { ConsoleCommand, KeyBinding } from "./contributions.js";

/** A command the frame itself contributes: its `when` is the console's vocabulary. */
export type FrameCommand = Omit<ConsoleCommand, "when"> & {
  readonly when?: ConsoleWhenClauseKey;
};

/** A chord the frame itself binds, scoped to the same vocabulary. */
export type FrameKeyBinding = Omit<KeyBinding, "when"> & {
  readonly when?: ConsoleWhenClauseKey;
};

/**
 * What the palette and the chord table need to offer one rail destination.
 *
 * Module-private: it names the shape of the table below and nothing consumes it
 * apart from that table, so exporting it would publish a type no caller can use
 * for anything the record does not already answer.
 */
interface RailNavigationDetail {
  readonly commandId: string;
  /** tinykeys syntax, single press. */
  readonly chord: string;
  /** Extra words a person might type for this destination in the palette. */
  readonly keywords: readonly string[];
}

/**
 * Going to a destination, as data — one row per destination, and the compiler
 * holds it total.
 *
 * A table rather than three hand-written commands beside three hand-written
 * bindings. Those were three lists over one closed set (`RAIL_DESTINATIONS`), and
 * the way they came apart is on record: the rail declared `workspace` where the
 * spec names `workflows`, and the palette and the chord table agreed with the rail
 * because each had been written to match the other rather than the set.
 *
 * The ids are written out rather than composed from the destination name. They are
 * the console's public command vocabulary — a person can bind one on the Keyboard
 * page — so they read as the console's other ids read (`family.verbNoun`), and
 * totality over the union is what makes the membership uncheatable regardless.
 *
 * The chords are positional for the first two and conventional for the third:
 * `$mod+,` is the platform's settings chord on every desktop the console targets,
 * and giving Settings a `$mod+3` to make the row tidy would cost a person the one
 * chord they already know.
 */
export const RAIL_NAVIGATION_DETAILS: Readonly<Record<RailDestination, RailNavigationDetail>> = {
  sessions: {
    commandId: "frame.goToSessions",
    chord: "$mod+1",
    keywords: ["list", "home"],
  },
  workflows: {
    commandId: "frame.goToWorkflows",
    chord: "$mod+2",
    keywords: ["builder", "automation", "graph"],
  },
  settings: {
    commandId: "frame.goToSettings",
    chord: "$mod+,",
    keywords: ["preferences", "options"],
  },
};

/**
 * The act the composer chord runs, named once for the two modules that need it.
 *
 * Declared here rather than in `frame/frame-commands.ts` beside the command it
 * identifies, for the reason the rail's ids are here: a binding names a command by
 * its id and nothing checks that the id resolves, so the binding table and the
 * command list have to read one declaration or a rename leaves a chord pointing at
 * nothing — a keystroke that silently does nothing, which is the exact symptom the
 * chord already had.
 */
export const COMPOSER_FOCUS_COMMAND_ID = "frame.focusComposer";

/**
 * Chords the frame itself binds: one per rail destination, then the composer chord.
 *
 * The destinations are WALKED from `RAIL_DESTINATIONS` so the bound set and the
 * rendered set are one set. `frame.goToWorkspace` is deliberately still chordless:
 * the three chords a person builds muscle memory for are the three icons in front of
 * them, and a fourth binding on a destination the rail does not draw is a keystroke
 * with nothing to point at.
 *
 * THE COMPOSER CHORD IS THE FRAME'S AND NOT THE COMPOSER FAMILY'S, because the frame
 * is what owns this window's chord table and the composer is mounted and unmounted
 * inside it. A binding contributed by the composer would come and go with the surface
 * that draws one, so the chord would answer in a session and be unbound everywhere
 * else — while the ask itself is dropped by the seat when no composer is listening,
 * which is the seat's own rule and needs no second statement as a `when` clause here.
 *
 * IT IS THE SAME CHORD THE MAIN PROCESS WATCHES FOR in an auxiliary window
 * (`src/shared/composer-chord.ts`), read from that one declaration rather than
 * spelled again: a window with no composer answers the press by asking THIS window,
 * and the two halves have to be one keystroke or the person presses one chord in one
 * window and a different chord in the other.
 *
 * `allowInTextInput`, and it is the one binding here that takes it. The chord's whole
 * job is to move the caret from wherever it is to the composer, and the places a
 * person most needs it from — a find field, a filter box, a form — are text inputs.
 * A rail chord fires in none of them for the opposite reason: navigating away while
 * somebody is typing loses what they typed.
 */
export const FRAME_KEY_BINDINGS: readonly FrameKeyBinding[] = [
  ...RAIL_DESTINATIONS.map((destination) => ({
    chord: RAIL_NAVIGATION_DETAILS[destination].chord,
    commandId: RAIL_NAVIGATION_DETAILS[destination].commandId,
  })),
  {
    chord: COMPOSER_FOCUS_CHORD,
    commandId: COMPOSER_FOCUS_COMMAND_ID,
    allowInTextInput: true,
  },
];

/**
 * Every chord the window binds: the frame's own, then the families'.
 *
 * Read by whatever installs the window's chord table, so a family's chords reach the
 * keyboard without the frame naming the family — the same relationship the surface
 * registry gives a family's routes. The families' half is read from
 * `console-commands.ts` beside this file, which is where their contributions are
 * collected.
 *
 * A FUNCTION AND NOT AN ARRAY, because the families' half is not known when this
 * module is evaluated. Read it once into a constant and the console binds whatever
 * had been composed by the time this file was imported, which is an ordering nobody
 * declared and nothing reports.
 */
export function consoleKeyBindings(): readonly KeyBinding[] {
  return [...FRAME_KEY_BINDINGS, ...consoleFamilyKeyBindings()];
}

/**
 * Told when {@link consoleKeyBindings} would answer differently.
 *
 * Paired with the reader rather than published beside the contribution door: a
 * caller that installs the table has to do both, and two names from one module is
 * what makes the pair hard to take apart. The frame's own half never changes, so
 * every change comes from the families.
 */
export function subscribeToConsoleKeyBindings(listener: () => void): Unsubscribe {
  return subscribeToConsoleFamilyContributions(listener);
}
