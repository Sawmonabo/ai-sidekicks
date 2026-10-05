// The acts the feed offers the palette, resolved when one is pressed. The chords are
// contributed before any feed exists, so an act cannot close over one; each is a value over
// state the feed holds, so a test can drive the set with no render.

import { type FindStepDirection } from "../find/model.js";
import { type TranscriptFindState } from "../find/hooks/useTranscriptFind.js";
import { type TranscriptActs } from "../mounted-transcript.js";

/** The state one window's acts are built over. */
export interface TranscriptStructureActInputs {
  readonly find: TranscriptFindState;
  /** The transcript's one scroll writer, for the walk's jumps. */
  readonly jumpToRow: (rowId: string) => void;
  readonly jumpToTail: () => void;
  /** Fold every terminal run group the feed has open. */
  readonly collapseAllTerminalRunGroups: () => void;
}

/**
 * Builds the acts a contributed transcript command runs.
 *
 * Written member by member, so an act added to `TranscriptActs` fails to compile here.
 */
export function buildTranscriptStructureActs(inputs: TranscriptStructureActInputs): TranscriptActs {
  const stepAndJump = (direction: FindStepDirection): void => {
    const walked = inputs.find.step(direction);
    if (walked !== undefined) {
      inputs.jumpToRow(walked.match.rowId);
    }
  };
  return {
    openFind: inputs.find.open,
    stepFindNext: () => {
      stepAndJump("next");
    },
    stepFindPrevious: () => {
      stepAndJump("previous");
    },
    jumpToLatest: inputs.jumpToTail,
    foldEveryRun: inputs.collapseAllTerminalRunGroups,
  };
}
