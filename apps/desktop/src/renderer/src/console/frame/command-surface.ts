// The frame's own command vocabulary: its `when` scoping, its rail table, its chords.
//
// THE REGISTRY IS NOT HERE ANY MORE. `palette/console-commands.ts` holds it, along
// with the `when`-clause vocabulary the types below are scoped to, and that module's
// header says why: every input those two had is the palette family's or below it, and
// neither of the consumers that need them can reach this family's door. A view family
// importing `frame/index.ts` closes a cycle — measured, `families.ts` → the family's
// door → `frame/index.ts` → `ConsoleRoot.tsx` → `families.ts` — and the composer's
// shell half, which stands above the console, closes the same one.
//
// What is left is the half the frame really owns: the shapes its own contributions
// take, the rail's navigation table, and the chords it binds itself.
//
// The frame's OWN commands are not registered at module scope either. They close over
// a live store, which module scope cannot reach, so `ConsoleRoot` registers them in an
// effect and removes them on unmount.

import type { ConsoleCommand, ConsoleWhenClauseKey, KeyBinding } from "../palette/index.js";
import { RAIL_DESTINATIONS, type RailDestination } from "../routing/index.js";

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
 * Chords the frame itself binds. A family's chords ride its own registration.
 *
 * Walked from `RAIL_DESTINATIONS` so the bound set and the rendered set are one
 * set. Nothing else is bound here: `frame.goToWorkspace` is offered in the palette
 * and carries no chord, because the three chords a person builds muscle memory for
 * are the three icons in front of them, and a fourth binding on a destination the
 * rail does not draw is a keystroke with nothing to point at.
 */
export const FRAME_KEY_BINDINGS: readonly FrameKeyBinding[] = RAIL_DESTINATIONS.map(
  (destination) => ({
    chord: RAIL_NAVIGATION_DETAILS[destination].chord,
    commandId: RAIL_NAVIGATION_DETAILS[destination].commandId,
  }),
);
