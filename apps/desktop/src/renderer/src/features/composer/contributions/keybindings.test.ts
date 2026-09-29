// The composer chord's binding: it runs the focus command, and it fires while typing.

import { describe, expect, it } from "vitest";

import { COMPOSER_FOCUS_COMMAND_ID } from "./commands.js";
import { COMPOSER_FOCUS_KEYBINDING } from "./keybindings.js";

describe("the composer's keybinding", () => {
  it("runs the focus command, and lets it fire while typing", () => {
    // Without `allowInTextInput` the chord declines in exactly the places a person
    // needs it from — a find field, a filter box — which reads as the binding not
    // existing at all.
    expect(COMPOSER_FOCUS_KEYBINDING.commandId).toBe(COMPOSER_FOCUS_COMMAND_ID);
    expect(COMPOSER_FOCUS_KEYBINDING.allowInTextInput).toBe(true);
  });
});
