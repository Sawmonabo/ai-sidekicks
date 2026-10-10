// Whether the faces the transcript's first rows draw in have settled, so the rows are first seen
// and measured in the faces they keep rather than in a fallback the faces then replace. The rows
// are laid out hidden first: that layout is what asks for each face their text needs, the split
// for every script it holds included, and this then waits on the document's own font set. The
// wait is bounded, so a face that never settles costs the rows nothing past it.

import { useLayoutEffect, useState } from "react";

import {
  diagnosticStampAt,
  windowDiagnosticCapture,
} from "#renderer/lib/diagnostic-capture/capture.js";
import { useOwnerWindow } from "#renderer/hooks/useOwnerWindow.js";
import { type FontLoadingDocument } from "#renderer/lib/font-loading-document.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";

/**
 * How long the rows wait for their faces, in milliseconds: the block period the font specification
 * recommends for `font-display: block`, which the faces declare. Past it the engine draws the
 * fallback anyway, so waiting longer would only hold rows back.
 */
export const TYPEFACE_WAIT_MS = 3000;

/**
 * Whether the faces the first committed rows draw in have loaded, or failed to, or have run past
 * `TYPEFACE_WAIT_MS`, which is recorded. `areRowsCommitted` says the first rows are in the
 * document; until then the answer is false. Settled in the same commit when every face the rows
 * ask for is already in, so a session switched back to shows its rows at once, and true from then
 * on.
 */
export function useTypefacesSettled(areRowsCommitted: boolean): boolean {
  const ownerWindow = useOwnerWindow();
  const clock = useClock();
  const fontLoadingDocument: FontLoadingDocument = ownerWindow.document;
  const fonts = fontLoadingDocument.fonts;
  const [isSettled, setIsSettled] = useState(false);
  // A layout effect, so a settled answer is drawn before the frame paints.
  useLayoutEffect(() => {
    if (isSettled || !areRowsCommitted) {
      return undefined;
    }
    if (fonts === undefined) {
      setIsSettled(true);
      return undefined;
    }
    // Lays the hidden rows out now, which asks for every face their text draws in.
    ownerWindow.document.documentElement.getBoundingClientRect();
    if (fonts.status === "loaded") {
      setIsSettled(true);
      return undefined;
    }
    let isWaiting = true;
    const bound = clock.scheduleTimeout(() => {
      isWaiting = false;
      windowDiagnosticCapture.record({
        at: diagnosticStampAt(clock),
        severity: "warning",
        source: "transcript/typefaces",
        kind: "typefaces-still-loading",
        detail: `The faces were still loading after ${String(TYPEFACE_WAIT_MS)} ms; the rows drew in the fallback.`,
      });
      setIsSettled(true);
    }, TYPEFACE_WAIT_MS);
    // The set's own promise: it settles once no load is pending, a failed load included.
    void fonts.ready.then(() => {
      if (isWaiting) {
        isWaiting = false;
        clock.cancel(bound);
        setIsSettled(true);
      }
    });
    return () => {
      isWaiting = false;
      clock.cancel(bound);
    };
  }, [isSettled, areRowsCommitted, fonts, clock, ownerWindow]);
  return isSettled;
}
