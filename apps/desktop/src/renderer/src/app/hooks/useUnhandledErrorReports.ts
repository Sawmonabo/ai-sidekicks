// The app's composition of its unhandled error reports: once the bridge resolves, the reports the
// console document held go to main through it, and every window the console document opens is
// listened to before anything is drawn in it.

import { useEffect } from "react";

import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import {
  windowErrorRoleOf,
  type UnhandledErrorReports,
} from "#renderer/services/platform/unhandled-error-reports.js";
import type { OpenWindows } from "#renderer/services/window/open-windows.js";

/** Sends `reports` through `bridge` and listens to every window `openWindows` opens. */
export function useUnhandledErrorReports(
  reports: UnhandledErrorReports,
  bridge: PlatformBridge,
  openWindows: OpenWindows,
): void {
  useEffect(
    () => reports.sendThrough((report) => bridge.app.reportUnhandledError(report)),
    [reports, bridge],
  );
  useEffect(
    () =>
      openWindows.prepareEveryDocument((windowDocument) => {
        const openedWindow = windowDocument.defaultView;
        if (openedWindow !== null) {
          reports.listenTo(openedWindow, windowErrorRoleOf(openedWindow.name));
        }
      }),
    [reports, openWindows],
  );
}
