import { useMemo } from "react";

import { useMountedTranscript } from "../../hooks/useMountedTranscript.js";
import {
  buildTranscriptStructureActs,
  type TranscriptStructureActInputs,
} from "../transcript-structure-acts.js";

/**
 * Hold the palette's seat for as long as the feed is mounted.
 *
 * The `useMemo` keeps the acts object stable across a render that changed none of its
 * inputs; the seat reads through its own ref either way, so this is a cost the feed avoids
 * rather than a correctness the seat depends on. Nothing is handed back: every act reaches
 * a person through a palette row or a chord, and none has a control on this surface.
 */
export function useTranscriptStructureActs(inputs: TranscriptStructureActInputs): void {
  const { find, jumpToRow, jumpToTail, collapseAllTerminalChapters } = inputs;
  const acts = useMemo(
    () =>
      buildTranscriptStructureActs({ find, jumpToRow, jumpToTail, collapseAllTerminalChapters }),
    [find, jumpToRow, jumpToTail, collapseAllTerminalChapters],
  );
  useMountedTranscript(acts);
}
