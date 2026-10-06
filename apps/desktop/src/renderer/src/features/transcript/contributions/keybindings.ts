// The chords the transcript claims in the keybinding table.

import { type Keybinding } from "#renderer/registries/commands/keybinding.js";
import { WHEN_SESSION_ACTIVE } from "#renderer/registries/commands/when-clause/vocabulary.js";

/**
 * The chords the transcript claims. `$mod` is Cmd on macOS and Ctrl elsewhere.
 * `allowInTextInput` stays off: a chord that wrongly fires while composing destroys text.
 */
export const TRANSCRIPT_KEY_BINDINGS: readonly Keybinding[] = [
  { chord: "$mod+f", commandId: "transcript.find", when: WHEN_SESSION_ACTIVE },
  { chord: "$mod+g", commandId: "transcript.findNext", when: WHEN_SESSION_ACTIVE },
];
