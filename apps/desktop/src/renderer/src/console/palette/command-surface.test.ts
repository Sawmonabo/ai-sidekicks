// The chords the frame binds, and the claim that its own `when` type is scoped to
// the console's published vocabulary.
//
// The registry and the vocabulary themselves are `console-commands.test.ts` beside
// this file. What is left here is the frame's contribution: one chord per rail
// destination plus the composer chord, and a binding type narrow enough that an
// unpublished key is a compile error rather than a clause that quietly evaluates
// false.
//
// The composer chord is checked here for a property no other file can see: that the
// string this table binds is the SAME declaration the main process watches for in an
// auxiliary window. Written out here it would be a second spelling, and the drift
// would be silent in both processes — one window answering a chord the other one
// does not.
//
// Both subjects are this family's now, so both specifiers are same-family ones. The
// tuple is reached directly because `palette/index.js` deliberately does not publish
// it — its only production reader is the type derived from it, and a door line for a
// symbol no production module imports is one `barrel-census` fails.

import { afterEach, describe, expect, it } from "vitest";

import { COMPOSER_FOCUS_CHORD } from "../../../../shared/composer-chord.js";
import { RAIL_DESTINATIONS } from "../routing/index.js";
import {
  COMPOSER_FOCUS_COMMAND_ID,
  FRAME_KEY_BINDINGS,
  RAIL_NAVIGATION_DETAILS,
  consoleKeyBindings,
  type FrameKeyBinding,
} from "./command-surface.js";
import { CONSOLE_WHEN_CLAUSE_KEYS, consoleCommandSurface } from "./console-commands.js";

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
  it("binds one chord per rail destination, in rail order, then the composer chord", () => {
    // The defect this pins is a chord table hand-written beside the destination
    // set: it kept a `$mod+2` for a Workspace destination the rail does not draw
    // and left the spec's workflows destination with no chord at all. The
    // destinations are still WALKED, so that claim is unchanged; the one addition
    // is named rather than admitted by loosening the comparison.
    expect(FRAME_KEY_BINDINGS.map((binding) => binding.commandId)).toStrictEqual([
      ...RAIL_DESTINATIONS.map((destination) => RAIL_NAVIGATION_DETAILS[destination].commandId),
      COMPOSER_FOCUS_COMMAND_ID,
    ]);
  });

  it("binds the composer chord to the cross-process declaration, and lets it fire while typing", () => {
    // Two claims about one row, and each is a way it goes wrong silently. A chord
    // spelled here rather than imported drifts from the one the main process
    // watches for, so the press works in one window and does nothing in the other.
    // And without `allowInTextInput` the chord declines in exactly the places a
    // person needs it from — a find field, a filter box — which reads as the
    // binding not existing at all.
    const composerBinding = FRAME_KEY_BINDINGS.find(
      (binding) => binding.commandId === COMPOSER_FOCUS_COMMAND_ID,
    );

    expect(composerBinding?.chord).toBe(COMPOSER_FOCUS_CHORD);
    expect(composerBinding?.allowInTextInput).toBe(true);
  });

  it("negative control: no rail chord fires while somebody is typing", () => {
    // Proves the case above is reading a real per-binding flag rather than one this
    // table sets on everything: navigating away mid-sentence loses the sentence, so
    // the rail's chords must decline exactly where the composer's fires.
    for (const destination of RAIL_DESTINATIONS) {
      const railBinding = FRAME_KEY_BINDINGS.find(
        (binding) => binding.commandId === RAIL_NAVIGATION_DETAILS[destination].commandId,
      );
      expect(railBinding?.allowInTextInput).toBeUndefined();
    }
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

describe("command surface — the window's whole chord table", () => {
  afterEach(() => {
    consoleCommandSurface.contribute({
      owner: "command-surface-test",
      commands: [],
      keyBindings: [],
    });
  });

  it("is the frame's own chords, then the families', in that order", () => {
    // The order is the claim, not an artefact. The window table listens in the
    // capture phase and the first match wins, so a family able to precede the
    // frame could take `$mod+1` away from the rail without anything reporting it.
    consoleCommandSurface.contribute({
      owner: "command-surface-test",
      commands: [
        { id: "command-surface-test.act", title: "Act", group: "Test", run: () => undefined },
      ],
      keyBindings: [{ chord: "$mod+Shift+7", commandId: "command-surface-test.act" }],
    });

    expect(consoleKeyBindings()).toStrictEqual([
      ...FRAME_KEY_BINDINGS,
      { chord: "$mod+Shift+7", commandId: "command-surface-test.act" },
    ]);
  });

  it("negative control: with no family composed it is exactly the frame's own", () => {
    // Without this the case above would pass over a reader that answered the whole
    // list from somewhere else entirely, and over one that appended the frame's
    // chords twice.
    expect(consoleKeyBindings()).toStrictEqual([...FRAME_KEY_BINDINGS]);
  });
});
