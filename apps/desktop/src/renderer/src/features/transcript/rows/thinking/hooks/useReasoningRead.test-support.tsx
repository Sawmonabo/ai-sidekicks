// A bridge that fails until a case says otherwise, the count of what reached the wire, and the
// provider `renderHook` mounts a hook under.

import { PlatformBridgeProvider } from "#renderer/services/platform/PlatformBridgeProvider.js";
import { bridgeAnswering, type BridgeUnderTest } from "#test/helpers/fixture/bridge.js";

/** A bridge whose one scripted method fails until the case clears the flag. */
export interface RecoverableBridge {
  readonly held: BridgeUnderTest;
  /** Stop refusing, so the NEXT call is the one that succeeds. */
  readonly recover: () => void;
}

/**
 * A bridge that answers one method as the case says, and rejects it while a flag is set.
 *
 * The flag is read at call time, so the first call can fail and the second succeed without the
 * case rebuilding the bridge.
 */
export function bridgeFailingUntilCleared(
  method: string,
  reply: Record<string, unknown>,
): RecoverableBridge {
  let isFailing = true;
  const held = bridgeAnswering(async (call, passThrough) => {
    if (call.method !== method) {
      return passThrough();
    }
    if (isFailing) {
      throw new Error("the daemon is not reachable");
    }
    return reply;
  });
  return {
    held,
    recover: () => {
      isFailing = false;
    },
  };
}

/** How many times the case's method reached the wire. */
export function callsTo(held: BridgeUnderTest, method: string): number {
  return held.calls.filter((call) => call.method === method).length;
}

/** A wrapper mounting a hook under one bridge. */
export function inBridge(held: BridgeUnderTest) {
  return function BridgeWrapper(props: { readonly children: React.ReactNode }): React.JSX.Element {
    return <PlatformBridgeProvider bridge={held.bridge}>{props.children}</PlatformBridgeProvider>;
  };
}
