// The transcript's commands for the command registry, built from the acts of whichever
// transcript is mounted when one is pressed. They are contributed at composition so they and
// their chords exist from the first frame; with no transcript mounted an act states its refusal
// on the frame's banner. Each command closes over a supplied act, so invoking `run` is the test.

import { raiseCommandRefusal } from "@renderer/registries/commands/command-refusal.js";
import { type CommandDefinition } from "@renderer/registries/commands/command-types.js";
import { type CommandContributionRegistry } from "@renderer/registries/commands/command-contributions.js";
import {
  mountedTranscript,
  type TranscriptActName,
  type TranscriptActs,
  type MountedTranscript,
} from "../mounted-transcript.js";
import { TRANSCRIPT_KEY_BINDINGS, WHEN_SESSION_ACTIVE } from "./keybindings.js";

/**
 * The palette group every transcript command sits under. One binding because the group is also
 * a match field, and two spellings would split the palette's category list.
 */
export const TRANSCRIPT_COMMAND_GROUP = "Transcript";

/**
 * Build this window's transcript commands. A function of the acts, not a constant, because
 * every `run` closes over one window's transcript.
 */
export function createTranscriptCommands(acts: TranscriptActs): readonly CommandDefinition[] {
  return [
    {
      id: "transcript.find",
      title: "Find in this session",
      group: TRANSCRIPT_COMMAND_GROUP,
      when: WHEN_SESSION_ACTIVE,
      keywords: ["search", "grep"],
      run: acts.openFind,
    },
    {
      id: "transcript.findNext",
      title: "Next match",
      group: TRANSCRIPT_COMMAND_GROUP,
      when: WHEN_SESSION_ACTIVE,
      run: acts.stepFindNext,
    },
    {
      id: "transcript.findPrevious",
      title: "Previous match",
      group: TRANSCRIPT_COMMAND_GROUP,
      when: WHEN_SESSION_ACTIVE,
      run: acts.stepFindPrevious,
    },
    {
      id: "transcript.scrollToTail",
      title: "Jump to latest",
      group: TRANSCRIPT_COMMAND_GROUP,
      when: WHEN_SESSION_ACTIVE,
      keywords: ["follow", "bottom", "live"],
      run: acts.jumpToLatest,
    },
    {
      id: "transcript.collapseTerminalRunGroups",
      title: "Fold every finished run",
      group: TRANSCRIPT_COMMAND_GROUP,
      when: WHEN_SESSION_ACTIVE,
      keywords: ["fold", "collapse", "runs"],
      run: acts.foldEveryRun,
    },
  ];
}

/**
 * The owner string of the transcript's command contribution, shared with its screen and pane
 * claims. The registry is owner-scoped, so composing twice replaces the rows instead of
 * raising on their ids.
 */
export const TRANSCRIPT_COMMAND_OWNER = "transcript";

/**
 * Contribute the transcript's commands and chords to a window. Takes the registry so a test
 * contributes into one it owns.
 */
export function registerTranscriptCommands(
  registry: CommandContributionRegistry,
  transcript: MountedTranscript = mountedTranscript,
): void {
  registry.contribute({
    owner: TRANSCRIPT_COMMAND_OWNER,
    commands: createTranscriptCommands(actsOnTheMountedTranscript(transcript)),
    keyBindings: TRANSCRIPT_KEY_BINDINGS,
  });
}

/**
 * The act set every contributed command runs through. Written out rather than derived from a
 * name list, so an act added to `TranscriptActs` fails to compile here.
 */
function actsOnTheMountedTranscript(transcript: MountedTranscript): TranscriptActs {
  const perform = (act: TranscriptActName): void => {
    performOnMountedTranscript(transcript, act);
  };
  return {
    openFind: () => {
      perform("openFind");
    },
    stepFindNext: () => {
      perform("stepFindNext");
    },
    stepFindPrevious: () => {
      perform("stepFindPrevious");
    },
    jumpToLatest: () => {
      perform("jumpToLatest");
    },
    foldEveryRun: () => {
      perform("foldEveryRun");
    },
  };
}

/**
 * Perform one act, and state a refusal on the frame's banner: the only place a window with no
 * transcript can show it.
 */
function performOnMountedTranscript(transcript: MountedTranscript, act: TranscriptActName): void {
  const outcome = transcript.perform(act);
  if (outcome.status === "refused") {
    raiseCommandRefusal(outcome.refusal);
  }
}
