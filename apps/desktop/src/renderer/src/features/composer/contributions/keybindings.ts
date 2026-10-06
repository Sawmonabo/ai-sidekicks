// The composer's keybinding: the chord that asks for the composer from anywhere in the window.

import type { CommandContributionRegistry } from "#renderer/registries/commands/contributions.js";
import type { Keybinding } from "#renderer/registries/commands/keybinding.js";
import { COMPOSER_FOCUS_COMMAND_ID } from "./commands.js";

/**
 * The chord in `tinykeys` grammar. `KeyL` is the physical key code, the same key on every
 * layout; `$mod` is command on macOS and control elsewhere.
 */
export const COMPOSER_FOCUS_CHORD = "$mod+KeyL";

/**
 * The composer chord's binding. `allowInTextInput` because the chord exists to move the caret
 * out of text inputs such as a find field.
 */
export const COMPOSER_FOCUS_KEYBINDING: Keybinding = {
  chord: COMPOSER_FOCUS_CHORD,
  commandId: COMPOSER_FOCUS_COMMAND_ID,
  allowInTextInput: true,
};

const COMPOSER_KEYBINDING_OWNER = "composer-keybindings";

/** Contribute the composer's keybindings to the supplied registry, so tests own theirs. */
export function registerComposerKeybindings(registry: CommandContributionRegistry): void {
  registry.contribute({
    owner: COMPOSER_KEYBINDING_OWNER,
    commands: [],
    keyBindings: [COMPOSER_FOCUS_KEYBINDING],
  });
}
