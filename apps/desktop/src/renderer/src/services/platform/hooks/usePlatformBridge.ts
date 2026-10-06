import type { PlatformBridge } from "../bridge.js";
import { useReadyBridgeResolution } from "./useBridgeResolution.js";

/** The bridge, or a throw when the window resolved none. */
export function usePlatformBridge(): PlatformBridge {
  return useReadyBridgeResolution().bridge;
}
