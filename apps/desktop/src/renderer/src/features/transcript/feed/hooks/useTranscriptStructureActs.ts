// The acts the feed offers the palette, resolved when one is pressed. The chords are contributed
// before any feed exists, so an act cannot close over one; each is a value over state the feed
// holds.

import { useMemo } from "react";

import { type FindStepDirection } from "../../find/matcher.js";
import { useMountedTranscript } from "../../hooks/useMountedTranscript.js";
import { type TranscriptActs } from "../../mounted-transcript.js";

/**
 * Fill the mounted-transcript holder the palette reads, for as long as the feed is mounted, and
 * tell it whether the transcript holds a run group. The acts are written member by member, so an
 * act added to `TranscriptActs` fails to compile here, and the `useMemo` keeps them one object
 * across a render that changed none of its inputs; the holder reads through its own ref either
 * way. Nothing is handed back: every act reaches a person through a palette row or a chord.
 */
export function useTranscriptStructureActs(
  inputs: TranscriptStructureActInputs,
  holdsRunGroup: boolean,
): void {
  const { openFind, stepFind, jumpToTail, foldEveryRun, unfoldEveryRun } = inputs;
  const acts = useMemo(
    (): TranscriptActs => ({
      openFind,
      stepFindNext: () => {
        stepFind("next");
      },
      stepFindPrevious: () => {
        stepFind("previous");
      },
      jumpToLatest: jumpToTail,
      foldEveryRun,
      unfoldEveryRun,
    }),
    [openFind, stepFind, jumpToTail, foldEveryRun, unfoldEveryRun],
  );
  useMountedTranscript(acts, holdsRunGroup);
}

/** The state one window's acts are built over. */
interface TranscriptStructureActInputs {
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
