import { useContext } from "react";

import { BridgeContext, type BridgeResolution } from "../bridge-context.js";

/**
 * The resolution including its failure arm, for the frame's own error surface. Throws
 * outside the provider: every surface renders inside it so the fixture is substitutable.
 */
export function useBridgeResolution(): BridgeResolution {
  const resolution = useContext(BridgeContext);
  if (resolution === undefined) {
    throw new Error(
      "usePlatformBridge was called outside <PlatformBridgeProvider>. Every console surface renders inside the provider so the fixture is substitutable.",
    );
  }
  return resolution;
}
