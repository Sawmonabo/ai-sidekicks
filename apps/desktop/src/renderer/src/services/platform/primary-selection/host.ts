// The host's primary selection, picked from whether the system keeps one, as the bridge reports.

import type { PlatformBridge } from "../bridge.js";
import type { PrimarySelection } from "./contract.js";
import { keptPrimarySelection } from "./kept.js";
import { NO_PRIMARY_SELECTION } from "./none.js";

/** This system's primary selection: the one it keeps, or none where it keeps none. */
export function primarySelectionFor(bridge: PlatformBridge): PrimarySelection {
  return bridge.app.hasPrimarySelection ? keptPrimarySelection(bridge) : NO_PRIMARY_SELECTION;
}
