// One session's identity as the fixture derives it from one scenario. It is not part of the
// directory derivation because that answers "which sessions does the service have" under a
// visibility rule, while this names a session the caller already holds, including one still
// provisioning. It carries no title: a scenario scripts only the session read, which has none.

import { isWireRecord } from "#renderer/lib/wire/record.js";
import type { SessionSummary } from "./summary.js";
import type { Scenario } from "#fixtures/scenario.js";

/**
 * The identity the scenario declares for one session, or `undefined` when the scenario scripts no
 * session read or is not playing that session.
 */
export function scenarioSessionIdentity(
  scenario: Scenario,
  sessionId: string,
): SessionSummary | undefined {
  if (sessionId !== scenario.sessionId) {
    return undefined;
  }
  // The scripted reply's `result` is untyped, so the state is reached by a narrowing walk.
  const result = scenario.replies.find((reply) => reply.call === "session.read")?.result;
  const session = isWireRecord(result) ? result["session"] : undefined;
  const state = isWireRecord(session) ? session["state"] : undefined;
  if (typeof state !== "string") {
    return undefined;
  }
  return { sessionId, state };
}
