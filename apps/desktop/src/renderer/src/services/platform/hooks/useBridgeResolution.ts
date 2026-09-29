import { useContext } from "react";

import { BridgeContext, type BridgeResolution } from "../bridge-context.js";

/**
 * The resolution including its failure arm, for the app's own error view. Throws
 * outside the provider: every component renders inside it so the fixture is substitutable.
 */
export function useBridgeResolution(): BridgeResolution {
  const resolution = useContext(BridgeContext);
  if (resolution === undefined) {
    throw new Error(
      "usePlatformBridge was called outside <PlatformBridgeProvider>. Every component renders inside the provider so the fixture is substitutable.",
    );
  }
  return resolution;
}

/**
 * The resolved bridge and its clock, or a throw. A component that reaches for either with no
 * bridge resolved is a wiring bug, and an `undefined` return would let it render an empty
 * state that looks like "no data".
 */
export function useReadyBridgeResolution(): Extract<BridgeResolution, { status: "ready" }> {
  const resolution = useBridgeResolution();
  if (resolution.status === "unavailable") {
    throw new Error(`console bridge unavailable: ${resolution.unavailable.detail}`);
  }
  return resolution;
}
