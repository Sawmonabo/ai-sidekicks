// One reader for the scripted `session.read` reply, because two derivations need it.
//
// A scenario's session read is its statement of what that session IS, and two
// modules beside this one derive different facts from it: `fixture-session-
// directory.ts` reads the state, to decide whether the node lists the session at all,
// and `fixture-session-snapshot.ts` reads the cursor block, so the store that opens on
// that session can run the resume rule against real positions.
//
// The reply's `result` is deliberately untyped — a scenario carries any registered
// reply — so reaching a member of it is a narrowing walk rather than a property
// access. Written twice, the two walks would be two answers to "what did the scenario
// say", free to disagree about a reply that is half a record; `apps/desktop/AGENTS.md`
// hoists a helper on its second use, and this is that use.

import { isWireRecord } from "../../core/index.js";
import type { ConsoleScenario } from "../scenario-runtime/index.js";

/** The wire call a scenario states its session through. */
const SESSION_READ_CALL = "session.read";

/**
 * One member of the scripted session read's reply, or `undefined`.
 *
 * `path` walks from the reply's `result` downward, so a caller names the member it
 * wants and never the intermediate records — which is what keeps the narrowing in one
 * place rather than at each call site.
 */
export function scriptedSessionReadMember(
  scenario: ConsoleScenario,
  ...path: readonly string[]
): unknown {
  const reply = scenario.replies.find((candidate) => candidate.call === SESSION_READ_CALL);
  let value: unknown = reply?.result;
  for (const member of path) {
    value = isWireRecord(value) ? value[member] : undefined;
  }
  return value;
}
