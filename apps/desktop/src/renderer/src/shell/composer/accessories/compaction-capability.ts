// Whether the composer's BOUND driver declares compaction, in the control's own words.
//
// The rail is addressed at one agent with one binding, so the question it has to ask
// is "does THIS driver declare it" — and `driver.listCapabilities` answers with one
// report per driver, any of which may lack the flag. An intersection across every
// reported driver answers a different question: it hides a capable driver's control
// whenever some other driver in the session lacks it.
//
// THE READ IS THE BRIDGE'S AND THIS IS THE MAPPING. `bridge/driver-capability-read.ts`
// performs one call per bridge for every family that gates on it; what is left here
// is the composer's own vocabulary, which is a different closed set from the runs
// pane's boolean gate — the control renders three states and a boolean cannot carry
// the third.
//
// FAIL-CLOSED, IN THE ONLY DIRECTION THAT IS HONEST HERE. An unread capability set is
// `unknown` and not `undeclared`: the design's absent-not-disabled discipline makes
// `undeclared` an absence with nothing to say, and rule 8 makes `unknown` the
// `not-checked` reading — the question was never put. Collapsing the two would have a
// composer whose read has not landed look exactly like one bound to a driver that
// cannot compact.

import {
  declaredFlagsForDriver,
  type DriverCapabilityReadout,
} from "../../../console/bridge/index.js";
import type { CompactionCapabilityState } from "./CompactionControl.js";

/**
 * The compaction capability of one named driver, in the control's own vocabulary.
 *
 * `unknown` covers three genuinely identical situations — the read has not answered,
 * the wire has not named this agent's driver, and the reply named no such driver —
 * because in all three nobody has answered the question for THIS binding.
 */
export function compactionCapabilityFor(
  readout: DriverCapabilityReadout | undefined,
  driverName: string | undefined,
): CompactionCapabilityState {
  const flags = declaredFlagsForDriver(readout, driverName);
  if (flags === undefined) {
    return "unknown";
  }
  return flags.context_compaction ? "declared" : "undeclared";
}
