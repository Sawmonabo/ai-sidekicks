// The composer's commands: the palette row that asks for the composer, and the one that moves the
// command the agent waits on to the background.
//
// Each asks rather than acts: the composer owns its input element and follows its session's
// running commands, so it decides what the ask means. There is deliberately no `when` clause:
// whether a composer is mounted is already answered by a listener existing, and an ask nobody
// listens for is dropped.

import type { CommandContributionRegistry } from "#renderer/registries/commands/contributions.js";
import type { CommandDefinition } from "#renderer/registries/commands/definition.js";
import { requestMoveToBackground } from "../background-requests.js";
import { requestComposerFocus } from "../focus-requests.js";

/**
 * Id of the focus-composer command, shared by the command and its keybinding. A binding
 * names a command by id and nothing checks it resolves, so both read this one constant.
 */
export const COMPOSER_FOCUS_COMMAND_ID = "frame.focusComposer";

/** Id of the move-to-background command, shared by the command and its keybinding. */
export const MOVE_TO_BACKGROUND_COMMAND_ID = "composer.moveCommandToBackground";

const COMPOSER_COMMAND_OWNER = "composer-commands";

const FOCUS_COMPOSER_COMMAND: CommandDefinition = {
  id: COMPOSER_FOCUS_COMMAND_ID,
  title: "Focus the composer",
  group: "Compose",
  keywords: ["message", "type", "prompt", "input"],
  run: () => {
    requestComposerFocus();
  },
};

const MOVE_TO_BACKGROUND_COMMAND: CommandDefinition = {
  id: MOVE_TO_BACKGROUND_COMMAND_ID,
  title: "Move to background",
  group: "Compose",
  keywords: ["command", "background", "running"],
  run: () => {
    requestMoveToBackground();
  },
};

/** Contribute the composer's commands to a window's registry (a parameter, so tests own theirs). */
export function registerComposerCommands(registry: CommandContributionRegistry): void {
  registry.contribute({
    owner: COMPOSER_COMMAND_OWNER,
    commands: [FOCUS_COMPOSER_COMMAND, MOVE_TO_BACKGROUND_COMMAND],
    keyBindings: [],
  });
}
