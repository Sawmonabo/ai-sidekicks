import type { ConsoleBridge } from "../platform-bridge.js";
import { useBridgeResolution } from "./useBridgeResolution.js";

/**
 * The bridge, or a throw. A component that reaches for the bridge outside the provider is a
 * wiring bug, and an `undefined` return would let it render an empty state that looks like
 * "no data".
 */
export function useConsoleBridge(): ConsoleBridge {
  const resolution = useBridgeResolution();
  if (resolution.status === "unavailable") {
    throw new Error(`console bridge unavailable: ${resolution.unavailable.detail}`);
  }
  return resolution.bridge;
}
