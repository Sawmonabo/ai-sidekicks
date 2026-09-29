// Whether a scenario scripts a reply for a call nothing can make.

import type { Scenario } from "../scenario.js";

/**
 * Calls no method registry in the corpus carries, so no surface can ever make one.
 *
 * `session.list` reads exactly like a real method, and the daemon registry has
 * `session.read` and no list verb.
 */
const UNREGISTERED_CALLS: readonly string[] = ["session.list"];

/** Every scripted call in a scenario that names no registered method. */
export function unregisteredScriptedCalls(scenario: Scenario): readonly string[] {
  return scenario.replies
    .map((reply) => reply.call)
    .filter((call) => UNREGISTERED_CALLS.includes(call));
}
