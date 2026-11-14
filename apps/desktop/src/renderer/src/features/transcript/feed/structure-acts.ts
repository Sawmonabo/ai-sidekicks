// The acts the feed offers the palette, resolved when one is pressed. The chords are
// contributed before any feed exists, so an act cannot close over one; each is a value over
// state the feed holds, so a test can drive the set with no render.

import { type FindStepDirection } from "../find/matcher.js";
import { type TranscriptActs } from "../mounted-transcript.js";

/** The state one window's acts are built over. */
export interface TranscriptStructureActInputs {
  /** Reveal the find field without touching its query or walk. */
  readonly openFind: () => void;
  /** The find field's own step: the next or previous match, opened and scrolled to. */
  readonly stepFind: (direction: FindStepDirection) => void;
  readonly jumpToTail: () => void;
  /** Fold every run group, holding the row nearest the middle where it stands. */
  readonly foldEveryRun: () => void;
  /** Open every run group, holding the row nearest the middle where it stands. */
  readonly unfoldEveryRun: () => void;
}

/**
 * Builds the acts a contributed transcript command runs.
 *
 * Written member by member, so an act added to `TranscriptActs` fails to compile here.
 */
export function buildTranscriptStructureActs(inputs: TranscriptStructureActInputs): TranscriptActs {
  return {
    openFind: inputs.openFind,
    stepFindNext: () => {
      inputs.stepFind("next");
    },
    stepFindPrevious: () => {
      inputs.stepFind("previous");
    },
    jumpToLatest: inputs.jumpToTail,
    foldEveryRun: inputs.foldEveryRun,
    unfoldEveryRun: inputs.unfoldEveryRun,
  };
}
