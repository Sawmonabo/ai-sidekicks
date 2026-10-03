// The composer's commands: the palette row that asks for the composer.
//
// It asks rather than focuses: the composer owns its input element, so it decides what focusing
// means. There is deliberately no `when` clause: whether a composer is mounted is already
// answered by a focus listener existing, and an ask nobody listens for is dropped.

import type { CommandContributionRegistry } from "@renderer/registries/commands/command-contributions.js";
import type { CommandDefinition } from "@renderer/registries/commands/command-types.js";
import { requestComposerFocus } from "../composer-focus-requests.js";

/**
 * Id of the focus-composer command, shared by the command and its keybinding. A binding
 * names a command by id and nothing checks it resolves, so both read this one constant.
 */
export const COMPOSER_FOCUS_COMMAND_ID = "frame.focusComposer";

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

/** Contribute the composer's commands to a window's registry (a parameter, so tests own theirs). */
export function registerComposerCommands(registry: CommandContributionRegistry): void {
  registry.contribute({
    owner: COMPOSER_COMMAND_OWNER,
    commands: [FOCUS_COMPOSER_COMMAND],
    keyBindings: [],
  });
}
