// The composer's commands: the palette row that asks for the composer.
//
// IT ASKS RATHER THAN FOCUSES. The composer's input element is created and destroyed by
// its own mount, so what travels is the ask and the composer decides what focusing
// means.
//
// NO `when` CLAUSE, deliberately. Whether a composer is mounted is a fact the focus
// request already answers by having a listener or not having one, and a clause here
// would be a second, staler answer to it — offered from Settings, where `sessionActive`
// is true and no composer is drawn, it would be exactly wrong. An ask nobody is
// listening for is dropped.

import type { CommandContributionRegistry } from "@renderer/registries/commands/command-contributions.js";
import type { CommandDefinition } from "@renderer/registries/commands/command-types.js";
import { requestComposerFocus } from "../composer-focus-requests.js";

/**
 * The act the composer chord runs, named once for the command and the binding.
 *
 * A binding names a command by its id and nothing checks that the id resolves, so the
 * binding and the command read one declaration or a rename leaves a chord pointing at
 * nothing.
 */
export const COMPOSER_FOCUS_COMMAND_ID = "frame.focusComposer";

/** The owner the composer's commands are contributed under. */
const COMPOSER_COMMAND_OWNER = "composer-commands";

/** The chord's act, and the palette row for people who do not know the chord. */
const FOCUS_COMPOSER_COMMAND: CommandDefinition = {
  id: COMPOSER_FOCUS_COMMAND_ID,
  title: "Focus the composer",
  group: "Compose",
  keywords: ["message", "type", "prompt", "input"],
  run: () => {
    requestComposerFocus();
  },
};

/**
 * Contribute the composer's commands to a window.
 *
 * Takes the surface rather than reaching for the module-scope one, so a test contributes
 * into a surface it owns.
 */
export function registerComposerCommands(surface: CommandContributionRegistry): void {
  surface.contribute({
    owner: COMPOSER_COMMAND_OWNER,
    commands: [FOCUS_COMPOSER_COMMAND],
    keyBindings: [],
  });
}
