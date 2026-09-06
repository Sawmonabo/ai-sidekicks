// The chords the frame binds, and the claim that its own `when` type is scoped to
// the console's published vocabulary.
//
// The registry and the vocabulary themselves are `palette/console-commands.test.ts`.
// What is left here is the frame's: one chord per rail destination, and a binding
// type narrow enough that an unpublished key is a compile error rather than a
// clause that quietly evaluates false.

import { describe, expect, it } from "vitest";

import { CONSOLE_WHEN_CLAUSE_KEYS } from "../palette/console-commands.js";
import { RAIL_DESTINATIONS } from "../routing/index.js";
import {
  FRAME_KEY_BINDINGS,
  RAIL_NAVIGATION_DETAILS,
  type FrameKeyBinding,
} from "./command-surface.js";

/**
 * The compile-time control for the frame's own binding shape.
 *
 * The frame binds no SCOPED chord today — its three rail destinations are
 * unconditional — so a runtime loop over scoped bindings would be a check with
 * nothing to check. The claim that matters holds anyway, one level up: a binding's
 * `when` is typed to the published vocabulary, so an unpublished key is a compile
 * error at the author's keyboard. If the type were ever widened to `string`, the
 * suppressed error would stop occurring and this directive would itself become the
 * error.
 */
const BINDING_THE_COMPILER_REJECTS: FrameKeyBinding = {
  chord: "$mod+9",
  commandId: "frame.goToSessions",
  // @ts-expect-error — `sessionActiveish` is not a key the console publishes.
  when: "sessionActiveish",
};

describe("command surface — the chords the frame binds", () => {
  it("binds one chord per rail destination, in rail order, and nothing besides", () => {
    // The defect this pins is a chord table hand-written beside the destination
    // set: it kept a `$mod+2` for a Workspace destination the rail does not draw
    // and left the spec's workflows destination with no chord at all.
    expect(FRAME_KEY_BINDINGS.map((binding) => binding.commandId)).toStrictEqual(
      RAIL_DESTINATIONS.map((destination) => RAIL_NAVIGATION_DETAILS[destination].commandId),
    );
  });

  it("negative control: an unpublished key is not in the vocabulary the type scopes to", () => {
    // Reads the object the `@ts-expect-error` above suppressed, so the directive is
    // a claim this file executes rather than a comment nobody runs.
    expect(CONSOLE_WHEN_CLAUSE_KEYS).not.toContain(BINDING_THE_COMPILER_REJECTS.when);
  });

  it("negative control: no two destinations answer to one chord", () => {
    // Without this, a table that gave every destination `$mod+1` would satisfy the
    // case above and leave two of the three chords dead — `keybinding-conflicts.ts`
    // would refuse the install, which is a raise at mount rather than an answer.
    const chords = FRAME_KEY_BINDINGS.map((binding) => binding.chord);
    expect(new Set(chords).size).toBe(chords.length);
  });
});
