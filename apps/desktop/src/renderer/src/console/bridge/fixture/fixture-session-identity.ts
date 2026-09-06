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
// WHERE THE TITLE COMES FROM, AND WHY IT IS `metadata`. No first-class name field
// exists on any registered session shape: `SessionSnapshot` carries `id`, `state`,
// `config`, `metadata`, and two timestamps, and `session.created`'s payload is
// `.strict()` with no title member at all. So a display title is metadata a session
// carries, read from the scenario's own scripted reply rather than folded out of a
// beat — which is the same rule the directory derivation states, applied to the same
// reply.

import { ConsoleRefusalError, refuse } from "../../core/index.js";
import type { GrowthSessionSummary } from "../growth-values/index.js";
import { scriptedSessionReadMember } from "./scripted-session-read.js";
import type { ConsoleScenario } from "../scenario-runtime/index.js";

/** The subsystem an identity-derivation refusal names as its author. */
const IDENTITY_ORIGIN = "fixture-session-identity";

/**
 * The identity the scenario declares for one session, or `undefined`.
 *
 * `undefined` on two different grounds, and both are the fixture declining to invent
 * rather than an omission: a scenario that scripts no session read has not said the
 * session exists, and a request for a session this scenario is not playing is a
 * question about a session this fixture knows nothing about. The caller turns either
 * into the port's own refusal, which is what a console with no registered read sees.
 */
export function scenarioSessionIdentity(
  scenario: ConsoleScenario,
  sessionId: string,
): GrowthSessionSummary | undefined {
  if (sessionId !== scenario.sessionId) {
    return undefined;
  }
  const state = scriptedSessionReadMember(scenario, "session", "state");
  if (typeof state !== "string") {
    return undefined;
  }
  const title = scriptedSessionReadMember(scenario, "session", "metadata", "title");
  if (title !== undefined && typeof title !== "string") {
    // A THROW rather than a dropped title, on `fixture-session-directory.ts`' terms:
    // a scenario is in-tree source, so a metadata title that is not a string is an
    // authoring defect, and rendering the session by its identifier would make it
    // indistinguishable from the ordinary untitled session the surface must also draw.
    throw new ConsoleRefusalError(
      refuse(
        IDENTITY_ORIGIN,
        "session-title-not-a-string",
        `a scenario declared its session's metadata title as ${typeof title}, and a display title is a string or absent`,
      ),
    );
  }
  return { sessionId, state, ...(title === undefined ? {} : { title }) };
}
