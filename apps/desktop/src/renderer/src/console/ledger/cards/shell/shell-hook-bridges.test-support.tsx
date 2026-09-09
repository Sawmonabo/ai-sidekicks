// What the shell's two row hooks are driven over: one bridge, one wrapper, one count.
//
// HOISTED ON THE SECOND USE, which is the split that put the reasoning read and the
// ask answer in modules of their own. Their suites moved apart with them and both need
// the same three things — a bridge that fails until the case says otherwise, the count
// of what actually reached the wire, and the provider `renderHook` mounts a hook
// under — so the shapes live here once rather than being written twice and drifting.
//
// This family's own home rather than `core/`: both readers are in `cards/shell/`, and
// nothing outside it drives these hooks. It dies with the shell, exactly as the two
// modules it serves do.

import { SidekicksBridgeProvider } from "../../../bridge/index.js";
import {
  bridgeAnswering,
  type BridgeUnderTest,
} from "../../../bridge/fixture/call-plane/bridge.test-support.js";

/** A bridge whose one scripted method fails until the case clears the flag. */
export interface RecoverableBridge {
  readonly held: BridgeUnderTest;
  /** Stop refusing, so the NEXT call is the one that succeeds. */
  readonly recover: () => void;
}

/**
 * A bridge that answers one method as the case says, and rejects it while a flag is set.
 *
 * The flag is read at CALL time rather than closed over at build time, because the
 * cases these serve are about a second press: the first call has to be able to fail
 * and the second to succeed without the case rebuilding the bridge between them.
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

/** A wrapper mounting a hook under one bridge, which is what both hooks resolve. */
export function inBridge(held: BridgeUnderTest) {
  return function BridgeWrapper(props: { readonly children: React.ReactNode }): React.JSX.Element {
    return <SidekicksBridgeProvider bridge={held.bridge}>{props.children}</SidekicksBridgeProvider>;
  };
}
