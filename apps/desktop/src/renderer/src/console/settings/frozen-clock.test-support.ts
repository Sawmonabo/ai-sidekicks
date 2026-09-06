// The frozen clock every settings suite moves, read off the bridge it is mounted on.
//
// WHY A CASE HAS TO MOVE ANYTHING. Every read a settings page performs is armed on
// the clock `useConsoleClock` resolved through the provider, and under the fixture
// that is the running scenario's frozen one. Real time moves none of it, so a case
// that waited on the wall clock would be waiting on a still picture until its budget
// ran out — and a case that constructed a second `ManualClock` would be advancing a
// time base the surface is not reading, which fails the same way and says less.
//
// NARROWED BY `instanceof` RATHER THAN CAST, so a bridge whose clock cannot be moved
// throws at the line that asked for it rather than at the assertion three settles
// later that could not say what was missing.
//
// ONE HOME PER FAMILY, WHICH IS THE MOST THIS ROLE CAN HAVE. `repos/
// scenario-clock.test-support.ts` holds the same accessor for its own family and this
// module is deliberately not an import of it: view families are siblings, and
// `console-view-family-isolation` fails a settings module that reaches into `repos/`.
// The hoist that would collapse the two has no home either — the inputs are the
// bridge's, and a family door publishes only what a production module reads, so a
// test-only accessor cannot leave `bridge/` through one. So the rule this file meets
// is the reachable one: exactly one copy inside `settings/`, and every suite here
// takes it.

import type { ConsoleBridge } from "../bridge/index.js";
import { ManualClock } from "../core/index.js";

/** The frozen clock the fixture bridge hands every subsystem a settings page composes. */
export function frozenClockOf(bridge: ConsoleBridge): ManualClock {
  const clock = bridge.scenarioEngine?.clock;
  if (!(clock instanceof ManualClock)) {
    throw new Error("the fixture bridge did not supply a frozen clock");
  }
  return clock;
}
