// The rail's chords, and the claim that the window's binding type is scoped to the
// published `when` vocabulary.

import { describe, expect, it } from "vitest";

import { RAIL_DESTINATIONS } from "@renderer/routing/route-readers.js";
import {
  WHEN_CLAUSE_KEYS,
  type FrameKeybinding,
} from "@renderer/registries/commands/window-command-registry.js";
import { RAIL_KEYBINDINGS, RAIL_NAVIGATION_DETAILS } from "./navigation-commands.js";

/**
 * The compile-time control for the window's binding shape: an unpublished `when` key is
 * a compile error. Were the type widened to `string`, this directive would itself fail.
 */
const BINDING_THE_COMPILER_REJECTS: FrameKeybinding = {
  chord: "$mod+9",
  commandId: "frame.goToSessions",
  // @ts-expect-error — `sessionActiveish` is not a key the window publishes.
  when: "sessionActiveish",
};

describe("navigation commands — the chords the rail binds", () => {
  it("binds one chord per rail destination, in rail order", () => {
    // A hand-written chord table could keep a chord for a destination the rail does not draw.
    expect(RAIL_KEYBINDINGS.map((binding) => binding.commandId)).toStrictEqual(
      RAIL_DESTINATIONS.map((destination) => RAIL_NAVIGATION_DETAILS[destination].commandId),
    );
  });

  it("negative control: no rail chord fires while somebody is typing", () => {
    for (const binding of RAIL_KEYBINDINGS) {
      expect(binding.allowInTextInput).toBeUndefined();
    }
  });

  it("negative control: an unpublished key is not in the vocabulary the type scopes to", () => {
    expect(WHEN_CLAUSE_KEYS).not.toContain(BINDING_THE_COMPILER_REJECTS.when);
  });

  it("negative control: no two destinations answer to one chord", () => {
    // Two destinations on one chord would pass the order case above; the table refuses it.
    const chords = RAIL_KEYBINDINGS.map((binding) => binding.chord);
    expect(new Set(chords).size).toBe(chords.length);
  });
});
