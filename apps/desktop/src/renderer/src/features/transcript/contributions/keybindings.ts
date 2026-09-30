// The chords the transcript claims in the keybinding table.

import { type Keybinding } from "@renderer/registries/commands/command-types.js";

/**
 * The `when` clause every transcript command and chord carries. The clause evaluator answers
 * `false` for a key the context lacks, so a window with no session offers none of them.
 */
export const WHEN_SESSION_ACTIVE = "sessionActive";

/**
 * The chords the transcript claims. `$mod` is Cmd on macOS and Ctrl elsewhere.
 * `allowInTextInput` stays off: a chord that wrongly fires while composing destroys text.
 */
export const TRANSCRIPT_KEY_BINDINGS: readonly Keybinding[] = [
  { chord: "$mod+f", commandId: "transcript.find", when: WHEN_SESSION_ACTIVE },
  { chord: "$mod+g", commandId: "transcript.findNext", when: WHEN_SESSION_ACTIVE },
];
