// A paste of the clipboard in a window while a copy of this app's is still being written waits for
// that copy, so it pastes what the person copied last rather than what the clipboard held before.
// The paste is held before any field sees it (the message box, a terminal, any other), and once
// every pending copy has written or given up, main pastes the clipboard into the field it was
// pressed in, as the window's Edit menu does: focus goes back there first if it moved meanwhile,
// and a paste whose field is gone is dropped, never put elsewhere, and recorded in the window's
// diagnostics. A paste with no copy pending goes straight through, and so does the one a
// middle-button release makes where that pastes the primary selection: the browser makes it in
// the same task as the release, after the release's listeners.

import { isHTMLElement } from "@floating-ui/utils/dom";
import { useEffect } from "react";

import { RealClock } from "#renderer/lib/clock.js";
import {
  diagnosticStampAt,
  windowDiagnosticCapture,
} from "#renderer/lib/diagnostic-capture/capture.js";
import { recordRejectedRequest } from "#renderer/lib/diagnostic-capture/rejected-request-record.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { primarySelectionFor } from "#renderer/services/platform/primary-selection/host.js";

/** The `MouseEvent.button` of the middle button. */
const MIDDLE_BUTTON = 1;

/** Holds a clipboard paste in `ownerWindow`, which `windowId` names, while a copy is pending. */
export function useHeldPaste(bridge: PlatformBridge, ownerWindow: Window, windowId: string): void {
  useEffect(() => {
    const copies = bridge.pendingClipboardCopies;
    const { isPastedByMiddleClick } = primarySelectionFor(bridge);
    // Set by a middle-button release until the task it came in ends.
    let isMiddleClickPasting = false;
    const markMiddleClick = (event: MouseEvent): void => {
      if (event.button !== MIDDLE_BUTTON) {
        return;
      }
      isMiddleClickPasting = true;
      ownerWindow.setTimeout(() => {
        isMiddleClickPasting = false;
      }, 0);
    };
    // Main pastes into the window's focused element, so the field the paste was pressed in takes
    // focus again first.
    const pasteInto = async (field: Element | null): Promise<void> => {
      if (field === null || !field.isConnected) {
        windowDiagnosticCapture.record({
          at: diagnosticStampAt(new RealClock()),
          severity: "warning",
          source: "app/useHeldPaste",
          kind: "held-paste-dropped",
          detail: "Drop a held paste: the field it was pressed in is gone.",
        });
        return;
      }
      if (ownerWindow.document.activeElement !== field && isHTMLElement(field)) {
        field.focus();
      }
      await bridge.window.paste(windowId);
    };
    const holdPaste = (event: ClipboardEvent): void => {
      if (!copies.isPending || isMiddleClickPasting) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      const field = ownerWindow.document.activeElement;
      void copies
        .settled()
        .then(() => pasteInto(field))
        .catch((failure: unknown) => {
          recordRejectedRequest("app/useHeldPaste", "held-paste-not-pasted", failure);
        });
    };
    // On the window, in the capture phase, so the paste is held before a field's own listener.
    ownerWindow.addEventListener("paste", holdPaste, { capture: true });
    if (isPastedByMiddleClick) {
      ownerWindow.addEventListener("mouseup", markMiddleClick, { capture: true });
    }
    return () => {
      ownerWindow.removeEventListener("paste", holdPaste, { capture: true });
      ownerWindow.removeEventListener("mouseup", markMiddleClick, { capture: true });
    };
  }, [bridge, ownerWindow, windowId]);
}
