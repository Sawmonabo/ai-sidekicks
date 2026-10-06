// The workflows screen's two keyed acts for the command registry, `Next waiting` and `Answer
// this run`. They are contributed at composition so they and their chords exist from the first
// frame, and each presses whatever on screen offers it at that moment. Where nothing on screen can
// take the act, the palette row stays listed with the reason, and the chord does nothing.

import { type CommandContributionRegistry } from "#renderer/registries/commands/contributions.js";
import { readCommandWindow } from "#renderer/registries/commands/command-window.js";
import { type CommandDefinition } from "#renderer/registries/commands/definition.js";
import type { WorkflowCommandTargets } from "../command-target.js";
import { WHEN_ON_WORKFLOWS, WORKFLOW_KEY_BINDINGS } from "./keybindings.js";
import { WORKFLOWS_OWNER } from "./panes.js";

/** The palette group the workflows commands sit under. */
const WORKFLOWS_COMMAND_GROUP = "Workflows";

/** Build the workflows commands over the two acts they press. */
export function createWorkflowCommands(
  commandTargets: WorkflowCommandTargets,
): readonly CommandDefinition[] {
  return [
    {
      id: "workflows.nextWaiting",
      title: "Next waiting",
      group: WORKFLOWS_COMMAND_GROUP,
      when: WHEN_ON_WORKFLOWS,
      keywords: ["run", "approval", "blocked"],
      get unavailable() {
        return commandTargets.nextWaiting.unavailable(readCommandWindow());
      },
      run: () => {
        commandTargets.nextWaiting.press(readCommandWindow());
      },
    },
    {
      id: "workflows.answerThisRun",
      title: "Answer this run",
      group: WORKFLOWS_COMMAND_GROUP,
      when: WHEN_ON_WORKFLOWS,
      keywords: ["approve", "submit", "keep going"],
      get unavailable() {
        return commandTargets.answerThisRun.unavailable(readCommandWindow());
      },
      run: () => {
        commandTargets.answerThisRun.press(readCommandWindow());
      },
    },
  ];
}

/**
 * Contribute the workflows commands and chords to a window, under the feature's owner, pressing
 * the acts the workflows screen is handed. Takes the registry so a test contributes into one it
 * owns.
 */
export function registerWorkflowCommands(
  registry: CommandContributionRegistry,
  commandTargets: WorkflowCommandTargets,
): void {
  registry.contribute({
    owner: WORKFLOWS_OWNER,
    commands: createWorkflowCommands(commandTargets),
    keyBindings: WORKFLOW_KEY_BINDINGS,
  });
}
