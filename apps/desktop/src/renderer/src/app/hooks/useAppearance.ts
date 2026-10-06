// The app's appearance: main's record, the one copy there is, applied to every open window's
// document root as each one arrives, and to each window opened after it before it draws. Main
// applies a scheme change only once its record is written, so a refused change leaves every window
// as it was (`unkept-scheme.ts` says so on the banner of the window that asked). The client is held
// per bridge and closed with it, as the UI-state store is.

import { useLayoutEffect } from "react";

import { useSubjectScopedResource } from "#renderer/hooks/subject-scoped/useSubjectScopedResource.js";
import { type SubjectScopedDisposal } from "#renderer/lib/subject-scoped/subject-scoped-disposal.js";
import type { PlatformBridge } from "#renderer/services/platform/platform-bridge.js";
import { AppearanceClient } from "#renderer/services/window/appearance-client.js";
import type { OpenWindows } from "#renderer/services/window/open-windows.js";
import type { AppearanceRecord } from "#shared/appearance.js";
import { applyAppearance } from "../token-installation.js";

/** Main's appearance record kept on every open window's document root; the client for the acts. */
export function useAppearance(bridge: PlatformBridge, openWindows: OpenWindows): AppearanceClient {
  const { value: client } = useSubjectScopedResource<AppearanceClient>(
    bridge,
    undefined,
    () => new AppearanceClient(bridge.window),
    APPEARANCE_CLIENT_DISPOSAL,
  );

  // Before paint, so a record that arrives with the first frame is not drawn a frame late.
  useLayoutEffect(() => {
    let stopApplying: () => void = () => undefined;
    const stopHearing = client.subscribe((record: AppearanceRecord) => {
      stopApplying();
      stopApplying = openWindows.prepareEveryDocument((windowDocument) => {
        applyAppearance(windowDocument, record);
      });
    });
    return () => {
      stopHearing();
      stopApplying();
    };
  }, [client, openWindows]);

  return client;
}

/** A client is closed with its bridge, and a closed one is replaced rather than reused. */
const APPEARANCE_CLIENT_DISPOSAL: SubjectScopedDisposal<AppearanceClient> = {
  dispose: (client) => {
    client.close();
  },
  isClosed: (client) => client.isClosed,
};
