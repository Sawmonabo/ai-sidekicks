// One session's identity as the fixture derives it from one scenario. It is not part of the
// directory derivation because that answers "which sessions does the service have" under a
// visibility rule, while this names a session the caller already holds, including one still
// provisioning. It carries no title: a scenario scripts only the session read, which has none.

import { scriptedSessionReadMember } from "../scripted/session-read.fixture.js";
import type { SessionSummary } from "./reads.js";
import type { Scenario } from "@fixtures/scenario.js";

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
  const state = scriptedSessionReadMember(scenario, "session", "state");
  if (typeof state !== "string") {
    return undefined;
  }
  return { sessionId, state };
}
