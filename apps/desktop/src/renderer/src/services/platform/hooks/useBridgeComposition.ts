import { useContext } from "react";

import { BridgeCompositionContext, type BridgeComposition } from "../bridge-context.js";

/** The composition this window's bridge was built by, or `undefined` when it reads the preload. */
export function useBridgeComposition(): BridgeComposition | undefined {
  return useContext(BridgeCompositionContext);
}
