import { useMemo } from "react";

import { useMountedLedger } from "../../hooks/useMountedTranscript.js";
import {
  buildLedgerStructureActs,
  type LedgerFeedActInputs,
} from "../transcript-structure-acts.js";

/**
 * Hold the palette's seat for as long as the feed is mounted.
 *
 * The `useMemo` keeps the acts object stable across a render that changed none of its
 * inputs; the seat reads through its own ref either way, so this is a cost the feed avoids
 * rather than a correctness the seat depends on. Nothing is handed back: every act reaches
 * a person through a palette row or a chord, and none has a control on this surface.
 */
export function useLedgerStructureActs(inputs: LedgerFeedActInputs): void {
  const { find, jumpToRow, jumpToTail, collapseAllTerminalChapters } = inputs;
  const acts = useMemo(
    () => buildLedgerStructureActs({ find, jumpToRow, jumpToTail, collapseAllTerminalChapters }),
    [find, jumpToRow, jumpToTail, collapseAllTerminalChapters],
  );
  useMountedLedger(acts);
}
