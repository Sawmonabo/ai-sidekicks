// The widths a pane's own window opens at, handed to main before the first window opens and again
// whenever the text size changes, since every pane width is root-relative.

import { useLayoutEffect } from "react";

import { recordRejectedRequest } from "#renderer/lib/diagnostic-capture/rejected-request-record.js";
import { rootFontSizePx } from "#renderer/lib/root-font-size.js";
import { paneWindowWidthsPx } from "#renderer/features/sessions/index.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import type { AppearanceClient } from "#renderer/services/window/appearance-client.js";

/**
 * Send main each pane kind's opening width at the current text size, once before any window opens
 * and again on every text size the appearance record carries after it. A layout effect, so it runs
 * ahead of the passive effects that open the windows.
 */
export function useSendPaneWindowWidths(
  bridge: PlatformBridge,
  appearance: AppearanceClient,
): void {
  useLayoutEffect(() => {
    let sentAtRootPx: number | undefined;
    const send = (rootPx: number): void => {
      if (rootPx === sentAtRootPx) {
        return;
      }
      sentAtRootPx = rootPx;
      bridge.window
        .setDefaultSizes({ paneWidths: paneWindowWidthsPx(rootPx) })
        .catch((failure: unknown) => {
          recordRejectedRequest("app/useSendPaneWindowWidths", "default-sizes-not-set", failure);
        });
    };
    // Main writes the kept text size onto the console document's root as it serves it, so the
    // first figures are right before main's record arrives.
    send(rootFontSizePx(document));
    return appearance.subscribe((record) => {
      send(record.textSize);
    });
  }, [bridge, appearance]);
}
