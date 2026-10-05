// This window's appearance: main's record, the one copy there is, applied to the document root as
// each one arrives, and the acts that ask main for another color scheme. Main applies a change
// only once its record is written, so a refused change leaves the window as it was and says so on
// the window's banner. The client is held per bridge and closed with it, as the UI-state store is.

import { useCallback, useLayoutEffect } from "react";

import { useSubjectScopedResource } from "@renderer/hooks/subject-scoped/useSubjectScopedResource.js";
import { refuse } from "@renderer/lib/refusal.js";
import { type SubjectScopedDisposal } from "@renderer/lib/subject-scoped/subject-scoped-disposal.js";
import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { AppearanceClient } from "@renderer/services/window/appearance-client.js";
import type { WindowStore } from "@renderer/store/window/window-store.js";
import type { SchemePreference } from "@renderer/styles/tokens.js";
import { applyAppearance } from "../token-installation.js";

/** The acts that ask main to change this window's color scheme. */
export interface UseAppearanceResult {
  readonly chooseScheme: (preference: SchemePreference) => void;
  /** The next scheme in the cycle a person steps through, after the one in force. */
  readonly chooseNextScheme: () => void;
}

/** Main's appearance record kept on this window's document root, and the scheme acts. */
export function useAppearance(
  bridge: PlatformBridge,
  frameStore: WindowStore,
): UseAppearanceResult {
  const { value: client } = useSubjectScopedResource<AppearanceClient>(
    bridge,
    undefined,
    () => new AppearanceClient(bridge.window),
    APPEARANCE_CLIENT_DISPOSAL,
  );

  // Before paint, so a record that arrives with the first frame is not drawn a frame late.
  useLayoutEffect(
    () =>
      client.subscribe((record) => {
        applyAppearance(document, record);
      }),
    [client],
  );

  const disclose = useCallback(
    (asked: Promise<void>) => {
      // Main's refusal crosses IPC and may name a subsystem the person cannot act on; the banner
      // says what it means for them.
      void asked.catch(() => {
        frameStore.raiseRefusalBanner(UNKEPT_SCHEME);
      });
    },
    [frameStore],
  );
  const chooseScheme = useCallback(
    (preference: SchemePreference) => {
      disclose(client.chooseScheme(preference));
    },
    [client, disclose],
  );
  const chooseNextScheme = useCallback(() => {
    disclose(client.chooseNextScheme());
  }, [client, disclose]);

  return { chooseScheme, chooseNextScheme };
}

/** What the window's banner says when main could not keep a scheme. */
const UNKEPT_SCHEME = refuse(
  "appearance",
  "scheme-not-kept",
  "The color scheme was not changed, because it could not be saved. The window keeps the " +
    "scheme it had.",
);

/** A client is closed with its bridge, and a closed one is replaced rather than reused. */
const APPEARANCE_CLIENT_DISPOSAL: SubjectScopedDisposal<AppearanceClient> = {
  dispose: (client) => {
    client.close();
  },
  isClosed: (client) => client.isClosed,
};
