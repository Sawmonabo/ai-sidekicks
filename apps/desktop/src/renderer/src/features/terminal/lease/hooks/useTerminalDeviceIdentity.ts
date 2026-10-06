// Which device this is, for the one terminal decision that needs it: `model.ts` tells
// `held-by-this-device` from `held-by-another-device` by comparing the holder's device id with
// this device's, so the take control waits for the identity. Held per `(bridge, sessionId)` by
// the subject-scoped holder.

import { useEffect } from "react";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { useSubjectScopedState } from "#renderer/hooks/subject-scoped/useSubjectScopedState.js";

/** Which device this is, or that the app has not been told yet. */
export type TerminalDeviceIdentity =
  | { readonly status: "not-loaded" }
  | { readonly status: "read"; readonly deviceId: string };

/** The state before the read lands, as one value, so a render never builds a fresh literal. */
const NOT_LOADED_DEVICE_IDENTITY: TerminalDeviceIdentity = { status: "not-loaded" };

/** Asks the daemon which device this is. */
export type ReadTerminalDeviceIdentity = (request: {
  readonly sessionId: string;
}) => Promise<{ readonly deviceId: string }>;

/** Read which device this is, once per bridge-and-session pair. */
export function useTerminalDeviceIdentity(
  bridge: PlatformBridge,
  sessionId: string,
  readDeviceIdentity: ReadTerminalDeviceIdentity,
): TerminalDeviceIdentity {
  const { value: identity, publish } = useSubjectScopedState<TerminalDeviceIdentity>(
    bridge,
    sessionId,
    () => NOT_LOADED_DEVICE_IDENTITY,
  );

  useEffect(() => {
    // `publish` is bound to this visit, so a read landing after the pane closed or the
    // session moved is dropped rather than filed under the fresh visit.
    void readDeviceIdentity({ sessionId }).then(({ deviceId }) => {
      publish({ status: "read", deviceId });
    });
  }, [publish, readDeviceIdentity, sessionId]);

  return identity;
}
