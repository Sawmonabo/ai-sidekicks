import { useMemo } from "react";

import { useMountedTranscript } from "../../hooks/useMountedTranscript.js";
import {
  buildTranscriptStructureActs,
  type TranscriptStructureActInputs,
} from "../structure-acts.js";

/**
 * Fill the mounted-transcript holder the palette reads, for as long as the feed is mounted, and
 * tell it whether the transcript holds a run group. The `useMemo` keeps the acts object stable
 * across a render that changed none of its inputs; the holder reads through its own ref either
 * way. Nothing is handed back: every act reaches a person through a palette row or a chord.
 */
export function useTranscriptStructureActs(
  inputs: TranscriptStructureActInputs,
  holdsRunGroup: boolean,
): void {
  const { find, jumpToRow, jumpToTail, foldEveryRun, unfoldEveryRun } = inputs;
  const acts = useMemo(
    () =>
      buildTranscriptStructureActs({ find, jumpToRow, jumpToTail, foldEveryRun, unfoldEveryRun }),
    [find, jumpToRow, jumpToTail, foldEveryRun, unfoldEveryRun],
  );
  useMountedTranscript(acts, holdsRunGroup);
}
