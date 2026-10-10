// The host's primary selection, picked once from the platform the bridge reports.

import type { PlatformBridge } from "../bridge.js";
import type { PrimarySelection } from "./contract.js";
import { linuxPrimarySelection } from "./linux.js";
import { MAC_AND_WINDOWS_PRIMARY_SELECTION } from "./mac-and-windows.js";

/** This operating system's primary selection: Linux's, or none on macOS and Windows. */
export function primarySelectionFor(bridge: PlatformBridge): PrimarySelection {
  return bridge.app.platform === "linux"
    ? linuxPrimarySelection(bridge)
    : MAC_AND_WINDOWS_PRIMARY_SELECTION;
}
