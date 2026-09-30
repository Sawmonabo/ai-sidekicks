// One session's identity, as the fixture derives it from one scenario.
//
// A MODULE OF ITS OWN AND NOT A SECOND FUNCTION IN THE DIRECTORY DERIVATION, because
// the two answer different questions and fail differently. The directory answers
// "which sessions does this node HAVE", and applies a visibility rule that
// deliberately hides two of the six registered states. This answers "what is THIS
// session called and what state is it in", which is a question about a session the
// caller already holds — a header over a provisioning session still has to name it,
// and borrowing the directory's rule would leave that header blank on exactly the
// session a first run is looking at.
//
// NO TITLE. A session's name is the sessions list's, and a scenario scripts only the
// session read, which carries none, so the identity this derives is untitled.

import { scriptedSessionReadMember } from "./scripted-session-read.fixture.js";
import type { SessionSummary } from "./session-reads.js";
import type { Scenario } from "../../../../../fixtures/scenario.js";

/**
 * The identity the scenario declares for one session, or `undefined`.
 *
 * `undefined` on two different grounds, and both are the fixture declining to invent
 * rather than an omission: a scenario that scripts no session read has not said the
 * session exists, and a request for a session this scenario is not playing is a
 * question about a session this fixture knows nothing about.
 *
 * @consumedBy the fixture's answer to the session read the header's title takes
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
