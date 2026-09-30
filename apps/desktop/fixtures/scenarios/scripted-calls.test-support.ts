// Whether a scenario scripts a reply for a call nothing can make.

import type { Scenario } from "../scenario.js";

/**
 * Calls a scenario must not script a reply for. `session.list` is a subscription in the
 * daemon contract, not a request/response call, and nothing in the renderer calls it, so a
 * reply for it would never be asked.
 */
const UNREGISTERED_CALLS: readonly string[] = ["session.list"];

/** Every scripted call in a scenario that names no registered method. */
export function unregisteredScriptedCalls(scenario: Scenario): readonly string[] {
  return scenario.replies
    .map((reply) => reply.call)
    .filter((call) => UNREGISTERED_CALLS.includes(call));
}
