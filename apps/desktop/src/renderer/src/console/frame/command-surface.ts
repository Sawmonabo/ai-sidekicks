// The frame's own command vocabulary: its `when` clauses, its rail chords, its table.
//
// THE REGISTRY AND THE FAMILY DOOR ARE NOT HERE ANY MORE. They are
// `palette/console-commands.ts`, whose header says why: every input they had is the
// palette family's or below it, and a view family that needs the contribution door
// cannot reach this one — `frame/index.ts` reaches `ConsoleRoot` and through it
// `families.ts` and every view family, so an edge from a family to this family's door
// closes a cycle, and the deep specifier every family wrote instead is what
// `console-cross-family-deep-import` reports. What is left here is the half the frame
// really owns: the `when`-clause vocabulary it evaluates, the rail's navigation table,
// and the chords it binds itself.
//
// The frame's OWN commands are not registered at module scope either. They close over
// a live store, which module scope cannot reach, so `ConsoleRoot` registers them in an
// effect and removes them on unmount.

import {
  consoleFamilyKeyBindings,
  type ConsoleCommand,
  type KeyBinding,
} from "../palette/index.js";
import { RAIL_DESTINATIONS, type RailDestination } from "../routing/index.js";

/**
 * The `when`-clause identifiers the frame publishes.
 *
 * Named here rather than as free strings at each call site so a family writing
 * `when: "sessionActive"` can see the vocabulary it is writing against, and so a
 * typo is a missing key (the clause evaluates false, the command is hidden)
 * rather than an invented one.
 *
 * There is one key per main-window route kind, `workspace` included: the workspace
 * is not a rail destination but it IS somewhere a person can be, and a "where am
 * I" vocabulary that skipped it would leave a family no way to scope a command to
 * the surface that has the most of them.
 *
 * The tuple is the declaration and every type below is derived from it. A second
 * hand-written union would be a closed set the compiler could not keep closed:
 * the frame would publish six keys and evaluate seven, and the extra one would be
 * silently false at every call site rather than a compile error at one.
 */
export const FRAME_WHEN_CLAUSE_KEYS = [
  "sessionActive",
  "onSessions",
  "onWorkspace",
  "onWorkflows",
  "onSettings",
  "inAuxiliaryWindow",
] as const;

export type FrameWhenClauseKey = (typeof FRAME_WHEN_CLAUSE_KEYS)[number];

/**
 * What the frame evaluates a `when` clause against.
 *
 * Narrower than the palette's `WhenClauseContext`, which is `Record<string,
 * boolean>` because a family may publish keys the frame has never heard of. The
 * frame's OWN context is exactly the vocabulary above — every key present, no key
 * invented — so a key added to the tuple is a compile error until the frame
 * derives it, and a key derived but never published is a compile error too.
 */
export type FrameWhenClauseContext = Readonly<Record<FrameWhenClauseKey, boolean>>;

/** A command the frame itself contributes: its `when` is the frame's vocabulary. */
export type FrameCommand = Omit<ConsoleCommand, "when"> & {
  readonly when?: FrameWhenClauseKey;
};

/** A chord the frame itself binds, scoped to the same vocabulary. */
export type FrameKeyBinding = Omit<KeyBinding, "when"> & {
  readonly when?: FrameWhenClauseKey;
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

/**
 * Every chord the window binds: the frame's own, then the families'.
 *
 * Read by the frame when it installs the table, so a family's chords reach the
 * keyboard without the frame naming the family — the same relationship the surface
 * registry gives a family's routes. The families' half is read through the palette
 * door, which is where their contributions are collected.
 */
export function consoleKeyBindings(): readonly KeyBinding[] {
  return [...FRAME_KEY_BINDINGS, ...consoleFamilyKeyBindings()];
}
