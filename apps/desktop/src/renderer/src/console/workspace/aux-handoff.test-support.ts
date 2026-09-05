// The growth port both hand-off suites hand an `AuxiliaryHandoff`.
//
// One module rather than a copy in each: the three window operations it serves are
// the preconditions of every case in both files, and two spellings of "the wire
// works" would let one suite drift into testing a port the other does not have.

import { createRefusingGrowthPort, type GrowthPort } from "../bridge/growth-port.js";

/** A port that serves the three window operations and refuses everything else. */
export function servingPort(windowId = "aux-window-1"): GrowthPort {
  return {
    ...createRefusingGrowthPort(),
    windowDetachPane: async () => ({ status: "served", value: { windowId } }),
    windowFocusAuxiliary: async () => ({ status: "served", value: undefined }),
    windowCloseAuxiliary: async () => ({ status: "served", value: undefined }),
  };
}
