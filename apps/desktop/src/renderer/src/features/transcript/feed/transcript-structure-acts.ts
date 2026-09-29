// What the feed offers the palette: five acts, resolved when one is pressed.
//
// The chords are contributed when the window composes, long before any feed exists, so an
// act cannot be a closure over one: it is resolved at press time against whichever
// transcript is mounted then, and built here so the component that mounts them holds calls
// rather than closures.
//
// Every act is a value over state the feed already holds: nothing below reaches a store, a
// bridge or the DOM. Find's walk is `useTranscriptFind`'s and the scroll is the viewport
// binding's, so the whole set can be driven by a test with no render at all.
//
// "Fold every finished run" never refuses: the headers are disclosures, and this
// act folds exactly the ones a person opened.

import { type FindStepDirection } from "../find/find-model.js";
import { type TranscriptFindState } from "../find/hooks/useTranscriptFind.js";
import { type TranscriptActs } from "../mounted-transcript.js";

/** The state one window's acts are built over. */
export interface TranscriptStructureActInputs {
  readonly find: TranscriptFindState;
  /** The transcript's one scroll writer, for the walk's jumps. */
  readonly jumpToRow: (rowId: string) => void;
  readonly jumpToTail: () => void;
  /** Fold every terminal chapter the feed has open. */
  readonly collapseAllTerminalChapters: () => void;
}

/**
 * Build the acts a contributed transcript command runs.
 *
 * Written out member by member rather than assembled from a name list, so an act added to
 * `TranscriptActs` fails to compile here instead of reaching a mounted transcript
 * through nothing.
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
    foldEveryRun: inputs.collapseAllTerminalChapters,
  };
}
