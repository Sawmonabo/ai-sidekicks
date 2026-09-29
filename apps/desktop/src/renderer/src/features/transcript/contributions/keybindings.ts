// The chords the transcript claims in the keybinding table.

import { type Keybinding } from "@renderer/registries/commands/command-types.js";

/**
 * The `when` clause every transcript command and chord carries.
 *
 * Fail-closed by construction: the palette's clause evaluator answers `false` for
 * a key the context does not carry, so a window with no session offers none of
 * these rather than offering acts with nothing to act on.
 */
export const WHEN_SESSION_ACTIVE = "sessionActive";

/**
 * The chords the transcript claims.
 *
 * `$mod` is Cmd on macOS and Ctrl elsewhere, which the palette's chord vocabulary
 * fixes. `allowInTextInput` is left off everywhere: none of these is a chord a
 * person wants firing while they are composing a message, and the asymmetry the
 * binding type names — a wrongly-firing chord destroys text, a wrongly-declining
 * one costs a menu — decides it.
 */
export const TRANSCRIPT_KEY_BINDINGS: readonly Keybinding[] = [
  { chord: "$mod+f", commandId: "transcript.find", when: WHEN_SESSION_ACTIVE },
  { chord: "$mod+g", commandId: "transcript.findNext", when: WHEN_SESSION_ACTIVE },
];
