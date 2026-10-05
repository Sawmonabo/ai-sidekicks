// One reader for the scripted `session.read` reply, shared by the two derivations that need it:
// `session/identity.fixture.ts` reads the state and `session/base-state.fixture.ts` reads the
// cursor block. The reply's `result` is untyped, so reaching a member is a narrowing walk; two
// copies of it could disagree about a reply that is half a record.

import { isWireRecord } from "@renderer/lib/wire/record.js";
import type { Scenario } from "@fixtures/scenario.js";

/** The wire call a scenario states its session through. */
const SESSION_READ_CALL = "session.read";

/**
 * One member of the scripted session read's reply, or `undefined`. `path` walks from the reply's
 * `result` downward, keeping the narrowing in one place.
 */
export function scriptedSessionReadMember(scenario: Scenario, ...path: readonly string[]): unknown {
  const reply = scenario.replies.find((candidate) => candidate.call === SESSION_READ_CALL);
  let value: unknown = reply?.result;
  for (const member of path) {
    value = isWireRecord(value) ? value[member] : undefined;
  }
  return value;
}
