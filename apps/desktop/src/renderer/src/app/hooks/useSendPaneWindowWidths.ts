// The widths a pane's own window opens at, handed to main before the first window opens and again
// whenever the text size changes, since every pane width is root-relative.

import { useLayoutEffect } from "react";

import { recordRejectedRequest } from "#renderer/lib/diagnostic-capture/rejected-request-record.js";
import { useRootFontSizePx } from "#renderer/hooks/useRootFontSizePx.js";
import { paneWindowWidthsPx } from "#renderer/features/sessions/index.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";

/**
 * Send main each pane kind's opening width at the text size of the document this is drawn in,
 * once before any window opens and again on each new size. A layout effect, so it runs ahead of
 * the passive effects that open the windows.
 */
export function useSendPaneWindowWidths(bridge: PlatformBridge): void {
  const rootPx = useRootFontSizePx();
  useLayoutEffect(() => {
    bridge.window
      .setDefaultSizes({ paneWidths: paneWindowWidthsPx(rootPx) })
      .catch((failure: unknown) => {
        recordRejectedRequest("app/useSendPaneWindowWidths", "default-sizes-not-set", failure);
      });
  }, [bridge, rootPx]);
}
