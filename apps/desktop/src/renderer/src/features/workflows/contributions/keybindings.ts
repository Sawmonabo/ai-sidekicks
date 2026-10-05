// The chords the workflows screen claims in the keybinding table.

import { type Keybinding } from "@renderer/registries/commands/command-types.js";
import { type WhenClauseKey } from "@renderer/registries/commands/window-command-registry.js";

/** The clause the workflows screen's commands and chords are live under. */
export const WHEN_ON_WORKFLOWS: WhenClauseKey = "onWorkflows";

/**
 * The screen's two chords, `⌥⌘N` and `⌥⌘↩` on macOS. The letter is matched by its key code,
 * since Option turns the typed character into another one. `allowInTextInput` stays off, so
 * both are inert while a text field has focus.
 */
export const WORKFLOW_KEY_BINDINGS: readonly Keybinding[] = [
  { chord: "$mod+Alt+KeyN", commandId: "workflows.nextWaiting", when: WHEN_ON_WORKFLOWS },
  { chord: "$mod+Alt+Enter", commandId: "workflows.answerThisRun", when: WHEN_ON_WORKFLOWS },
];
