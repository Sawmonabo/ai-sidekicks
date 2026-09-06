// The two things both `RouteSurface` picker suites need before they assert anything.
//
// `settle` is here rather than in either suite because the directory read is the
// state both of them are asking about: a second copy would be a second answer to
// "has the read landed", and the two would drift the first time the read grew a
// continuation. `BARE_TIMELINE_ROUTE` is here because the timeline's grammar — one
// identifier is enough — is the contrast the agent-console suite's last negative
// control is built on, so both suites name the same route.

import { act } from "@testing-library/react";

import { type ConsoleRoute } from "../routing/index.js";
import { drainMicrotasks } from "../core/microtask-drain.test-support.js";

/** The bare auxiliary address a Window-menu open lands on. */
export const BARE_TIMELINE_ROUTE: ConsoleRoute = { kind: "auxiliary", route: "timeline" };

/** Let the directory read settle, so an assertion is about the answer. */
export async function settle(): Promise<void> {
  await act(async () => {
    await drainMicrotasks();
  });
}
