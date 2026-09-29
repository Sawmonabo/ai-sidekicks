// The composer's keybinding: the chord that asks for the composer from anywhere in the window.

import type { CommandContributionRegistry } from "@renderer/registries/commands/command-contributions.js";
import type { Keybinding } from "@renderer/registries/commands/command-types.js";
import { COMPOSER_FOCUS_COMMAND_ID } from "./commands.js";

/**
 * The chord, in `tinykeys` grammar, that asks for the composer.
 *
 * Spelled with the physical `KeyL` code rather than the printed `l`: a code names one
 * physical key on every keyboard layout, while a printed character names a different
 * key on each. `$mod` is the platform's primary modifier — command on macOS, control
 * elsewhere.
 */
export const COMPOSER_FOCUS_CHORD = "$mod+KeyL";

/**
 * The composer chord's binding.
 *
 * `allowInTextInput`, because the chord's whole job is to move the caret from wherever
 * it is to the composer, and the places a person most needs it from — a find field, a
 * filter box, a form — are text inputs.
 */
export const COMPOSER_FOCUS_KEYBINDING: Keybinding = {
  chord: COMPOSER_FOCUS_CHORD,
  commandId: COMPOSER_FOCUS_COMMAND_ID,
  allowInTextInput: true,
};

/** The owner the composer's keybindings are contributed under. */
const COMPOSER_KEYBINDING_OWNER = "composer-keybindings";

/**
 * Contribute the composer's keybindings to a window.
 *
 * Takes the registry rather than reaching for the module-scope one, so a test contributes
 * into a registry it owns.
 */
export function registerComposerKeybindings(registry: CommandContributionRegistry): void {
  registry.contribute({
    owner: COMPOSER_KEYBINDING_OWNER,
    commands: [],
    keyBindings: [COMPOSER_FOCUS_KEYBINDING],
  });
}
