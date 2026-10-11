// The app's composition of its windows' diagnostics: once the bridge resolves, what the window's
// diagnostic capture holds goes to main through it, and every window the console document opens
// is listened to before anything is drawn in it.

import { useEffect } from "react";

import {
  windowDiagnosticCapture,
  windowDiagnosticRoleOf,
} from "#renderer/lib/diagnostic-capture/capture.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import type { OpenWindows } from "#renderer/services/window/open-windows.js";

/** Sends the window's diagnostics through `bridge` and listens to every window `openWindows` opens. */
export function useWindowDiagnostics(bridge: PlatformBridge, openWindows: OpenWindows): void {
  useEffect(
    () =>
      windowDiagnosticCapture.sendThrough((reports) => bridge.app.reportWindowDiagnostics(reports)),
    [bridge],
  );
  useEffect(
    () =>
      openWindows.prepareEveryDocument((windowDocument) => {
        const openedWindow = windowDocument.defaultView;
        if (openedWindow !== null) {
          windowDiagnosticCapture.listenTo(openedWindow, windowDiagnosticRoleOf(openedWindow.name));
        }
      }),
    [openWindows],
  );
}
