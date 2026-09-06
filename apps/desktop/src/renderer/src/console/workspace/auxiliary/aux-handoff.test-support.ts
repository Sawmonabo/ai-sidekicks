// The growth port both hand-off suites hand an `AuxiliaryHandoff`.
//
// One module rather than a copy in each: the three window operations it serves are
// the preconditions of every case in both files, and two spellings of "the wire
// works" would let one suite drift into testing a port the other does not have.

import { createRefusingGrowthPort, type GrowthPort } from "../../bridge/growth-port/growth-port.js";

/** A port that serves the three window operations and refuses everything else. */
export function servingPort(windowId = "aux-window-1"): GrowthPort {
  return {
    ...createRefusingGrowthPort(),
    windowDetachPane: async () => ({ status: "served", value: { windowId } }),
    windowFocusAuxiliary: async () => ({ status: "served", value: undefined }),
    windowCloseAuxiliary: async () => ({ status: "served", value: undefined }),
  };
}

/** What a rejecting wire says, so a case can read the sentence back off a refusal. */
export const WIRE_REJECTION_MESSAGE = "the auxiliary window channel closed";

/**
 * One rejecting call, shared by both ports below.
 *
 * The shape a live bridge takes when its transport is gone: the method exists and
 * returns a promise, and the promise rejects. It is the arm no fixture used to
 * produce, which is how four `await`s came to have no rejection path at all.
 */
const rejectWireCall = async (): Promise<never> => {
  throw new Error(WIRE_REJECTION_MESSAGE);
};

/** A port whose four window operations reject rather than answering. */
export function rejectingPort(): GrowthPort {
  return {
    ...createRefusingGrowthPort(),
    windowDetachPane: rejectWireCall,
    windowFocusAuxiliary: rejectWireCall,
    windowCloseAuxiliary: rejectWireCall,
    windowSubscribePaneErrors: rejectWireCall,
  };
}

/**
 * A port that detaches for real and then rejects both controls a placeholder offers.
 *
 * The two operations only reachable AFTER a detach, so a case about them has to be
 * handed a wire that serves the detach and fails afterwards — which is also the real
 * sequence, since a window is what stops being reachable.
 */
export function detachingThenRejectingPort(): GrowthPort {
  return {
    ...servingPort(),
    windowFocusAuxiliary: rejectWireCall,
    windowCloseAuxiliary: rejectWireCall,
  };
}
