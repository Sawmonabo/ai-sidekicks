// Which device this is, for the one terminal decision that needs it.
//
// `lease-model.ts` tells `held-by-this-device` from `held-by-another-device` by comparing the daemon's
// holder against this device's user, so the claim control is withheld until that
// identity has been read. The reading is held per `(bridge, sessionId)` by the console's
// one subject-scoped holder, which reverts it to `not-loaded` on the pass that first
// sees new inputs.

import { useEffect } from "react";

import type { ConsoleBridge } from "@renderer/console/bridge/console-bridge.js";
import { useSubjectScopedState } from "@renderer/hooks/subject-scoped/useSubjectScopedState.js";

/** Which device this is, or that the console has not been told yet. */
export type TerminalDeviceIdentity =
  | { readonly status: "not-loaded" }
  | { readonly status: "read"; readonly userId: string };

/** The state before the read lands, as one value, so a render never builds a fresh literal. */
const NOT_LOADED_VIEWER_IDENTITY: TerminalDeviceIdentity = { status: "not-loaded" };

/** Asks the daemon which user this device is. */
export type ReadTerminalViewerUser = (request: {
  readonly sessionId: string;
}) => Promise<{ readonly userId: string }>;

/** Read which identity this device carries, once per bridge-and-session pair. */
export function useTerminalDeviceIdentity(
  bridge: ConsoleBridge,
  sessionId: string,
  readViewerUser: ReadTerminalViewerUser,
): TerminalDeviceIdentity {
  const { value: identity, publish } = useSubjectScopedState<TerminalDeviceIdentity>(
    bridge,
    sessionId,
    () => NOT_LOADED_VIEWER_IDENTITY,
  );

  useEffect(() => {
    let isAbandoned = false;
    void readViewerUser({ sessionId }).then(({ userId }) => {
      // The pane closed, or an input changed, before the read landed. Settling
      // afterwards would publish a stale read's user into a fresh one.
      if (!isAbandoned) {
        publish({ status: "read", userId });
      }
    });
    return () => {
      isAbandoned = true;
    };
  }, [publish, readViewerUser, sessionId]);

  return identity;
}
