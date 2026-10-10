// The transcript's commands for the command registry, built from the acts of whichever
// transcript is mounted when one is pressed. They are contributed at composition so they and
// their chords exist from the first frame; with no transcript mounted an act states its refusal
// on the frame's banner. Each command closes over a supplied act, so invoking `run` is the test.

import { raiseCommandRefusal } from "#renderer/registries/commands/refusal.js";
import { readCommandWindow } from "#renderer/registries/commands/command-window.js";
import { type CommandDefinition } from "#renderer/registries/commands/definition.js";
import { type CommandContributionRegistry } from "#renderer/registries/commands/contributions.js";
import {
  forwardActs,
  mountedTranscript,
  type TranscriptActName,
  type TranscriptActs,
  type MountedTranscript,
} from "../mounted-transcript.js";
import { WHEN_SESSION_ACTIVE } from "#renderer/registries/commands/when-clause/vocabulary.js";
import { TRANSCRIPT_KEY_BINDINGS } from "./keybindings.js";
import { TRANSCRIPT_OWNER } from "./screens.js";

/**
 * The palette group every transcript command sits under. One binding because the group is also
 * a match field, and two spellings would split the palette's category list.
 */
export const TRANSCRIPT_COMMAND_GROUP = "Transcript";

/**
 * The clause the fold rows are offered under: a session is open and its transcript holds a run
 * group, so a person is never offered a fold with nothing to fold.
 */
const WHEN_TRANSCRIPT_HOLDS_RUN_GROUP = "sessionActive && transcriptHoldsRunGroup";

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
      id: "transcript.foldEveryRun",
      title: "Fold every run",
      group: TRANSCRIPT_COMMAND_GROUP,
      when: WHEN_TRANSCRIPT_HOLDS_RUN_GROUP,
      keywords: ["fold", "collapse", "runs"],
      run: acts.foldEveryRun,
      takesChord: false,
    },
    {
      id: "transcript.unfoldEveryRun",
      title: "Unfold every run",
      group: TRANSCRIPT_COMMAND_GROUP,
      when: WHEN_TRANSCRIPT_HOLDS_RUN_GROUP,
      keywords: ["unfold", "expand", "open", "runs"],
      run: acts.unfoldEveryRun,
      takesChord: false,
    },
  ];
}

/**
 * Contribute the transcript's commands and chords to a window, under the owner its screen and
 * pane claims carry. The registry is owner-scoped, so composing twice replaces the rows instead
 * of raising on their ids. Takes the registry so a test contributes into one it owns.
 */
export function registerTranscriptCommands(
  registry: CommandContributionRegistry,
  transcript: MountedTranscript = mountedTranscript,
): void {
  registry.contribute({
    owner: TRANSCRIPT_OWNER,
    commands: createTranscriptCommands(
      forwardActs((act) => {
        performOnMountedTranscript(transcript, act);
      }),
    ),
    keyBindings: TRANSCRIPT_KEY_BINDINGS,
  });
}

/**
 * Perform one act, and state a refusal on the frame's banner: the only place a window with no
 * transcript can show it.
 */
function performOnMountedTranscript(transcript: MountedTranscript, act: TranscriptActName): void {
  const outcome = transcript.perform(act, readCommandWindow());
  if (outcome.status === "refused") {
    raiseCommandRefusal(outcome.refusal);
  }
}
