// The vocabulary the frame publishes to write against, and the chords it binds.
//
// The registration door itself moved to `palette/console-commands.ts` with the
// registry it writes into, and its cases went with it. What is left here is the half
// the frame owns.
//
// The `when`-clause vocabulary is checked from both sides. A tuple that nothing
// reads at runtime is a claim about a set that no test can hold: it stays right
// only for as long as everyone remembers to edit two places, which is the exact
// failure the collapsed declaration exists to make impossible.

import { describe, expect, it } from "vitest";

import { RAIL_DESTINATIONS } from "../routing/index.js";
import {
  FRAME_KEY_BINDINGS,
  FRAME_WHEN_CLAUSE_KEYS,
  RAIL_NAVIGATION_DETAILS,
  type FrameKeyBinding,
  type FrameWhenClauseContext,
} from "./command-surface.js";

/** Every key the frame publishes, all false — the shape, not a situation. */
const NO_CONTEXT: FrameWhenClauseContext = {
  sessionActive: false,
  onSessions: false,
  onWorkspace: false,
  onWorkflows: false,
  onSettings: false,
  inAuxiliaryWindow: false,
};

/**
 * The compile-time control for the vocabulary.
 *
 * The frame binds no SCOPED chord today — its three rail destinations are
 * unconditional — so a runtime loop over scoped bindings would be a check with
 * nothing to check. The claim that matters holds anyway, one level up: a binding's
 * `when` is typed to the published vocabulary, so an unpublished key is a compile
 * error at the author's keyboard rather than a clause that quietly evaluates false
 * and hides the command. If the type were ever widened to `string`, the suppressed
 * error would stop occurring and this directive would itself become the error.
 */
const BINDING_THE_COMPILER_REJECTS: FrameKeyBinding = {
  chord: "$mod+9",
  commandId: "frame.goToSessions",
  // @ts-expect-error — `sessionActiveish` is not a key the frame publishes.
  when: "sessionActiveish",
};

describe("command surface — the published when-clause vocabulary", () => {
  it("names exactly the keys the frame's own context supplies", () => {
    // The tuple is the declaration and `FrameWhenClauseContext` is derived from
    // it, so the compiler already refuses a context that is missing a key or
    // invents one. This holds the other direction at runtime: that the tuple a
    // family READS is the same set, rather than a stale copy of it.
    expect([...FRAME_WHEN_CLAUSE_KEYS].sort()).toStrictEqual(Object.keys(NO_CONTEXT).sort());
  });

  it("negative control: a key nobody publishes is not in the vocabulary", () => {
    // Reads the object the `@ts-expect-error` above suppressed, so the directive
    // is a claim this file executes rather than a comment nobody runs.
    expect(FRAME_WHEN_CLAUSE_KEYS).not.toContain(BINDING_THE_COMPILER_REJECTS.when);
    expect(FRAME_WHEN_CLAUSE_KEYS).not.toContain("sessionActiveish");
    expect(Object.keys(NO_CONTEXT)).not.toContain("sessionActiveish");
  });
});

describe("command surface — the chords the frame binds", () => {
  it("binds one chord per rail destination, in rail order, and nothing besides", () => {
    // The defect this pins is a chord table hand-written beside the destination
    // set: it kept a `$mod+2` for a Workspace destination the rail does not draw
    // and left the spec's workflows destination with no chord at all.
    expect(FRAME_KEY_BINDINGS.map((binding) => binding.commandId)).toStrictEqual(
      RAIL_DESTINATIONS.map((destination) => RAIL_NAVIGATION_DETAILS[destination].commandId),
    );
  });

  it("negative control: no two destinations answer to one chord", () => {
    // Without this, a table that gave every destination `$mod+1` would satisfy the
    // case above and leave two of the three chords dead — `keybinding-conflicts.ts`
    // would refuse the install, which is a raise at mount rather than an answer.
    const chords = FRAME_KEY_BINDINGS.map((binding) => binding.chord);
    expect(new Set(chords).size).toBe(chords.length);
  });
});
