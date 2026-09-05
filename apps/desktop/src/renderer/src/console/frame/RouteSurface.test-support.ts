// The two things both `RouteSurface` picker suites need before they assert anything.
//
// `settle` is here rather than in either suite because the directory read is the
// state both of them are asking about: a second copy would be a second answer to
// "has the read landed", and the two would drift the first time the read grew a
// continuation. The LOOP is not here either — it is `core/settle.test-support.ts`'s,
// where nine suites' copies of it collapsed — and what stays is the pass count, which
// is a property of this surface's own effect chain. `BARE_TIMELINE_ROUTE` is here because the timeline's grammar — one
// identifier is enough — is the contrast the agent-console suite's last negative
// control is built on, so both suites name the same route.

import { settle as settlePasses } from "../core/settle.test-support.js";
import { type ConsoleRoute } from "../routing/index.js";

/** The bare auxiliary address a Window-menu open lands on. */
export const BARE_TIMELINE_ROUTE: ConsoleRoute = { kind: "auxiliary", route: "timeline" };

/**
 * One pass: the directory read lands, and nothing it settles schedules another.
 *
 * The bound is this surface's own and stays here; the loop is `core/`'s.
 */
const ROUTE_SURFACE_SETTLE_PASSES = 1;

/** Let the directory read settle, so an assertion is about the answer. */
export async function settle(): Promise<void> {
  await settlePasses(ROUTE_SURFACE_SETTLE_PASSES);
}
