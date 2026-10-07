// One session's identity as the fixture derives it from one scenario. It is not part of the
// directory derivation because that answers "which sessions does the service have" under a
// visibility rule, while this names a session the caller already holds, including one still
// provisioning. Its name is the one the scripted session read carries, absent while the session
// is untitled.

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
  // The scripted reply's `result` is untyped, so the record is reached by a narrowing walk.
  const result = scenario.replies.find((reply) => reply.call === "session.read")?.result;
  const session = isWireRecord(result) ? result["session"] : undefined;
  if (!isWireRecord(session) || typeof session["state"] !== "string") {
    return undefined;
  }
  const name = session["name"];
  return typeof name === "string"
    ? { sessionId, name, state: session["state"] }
    : { sessionId, state: session["state"] };
}
