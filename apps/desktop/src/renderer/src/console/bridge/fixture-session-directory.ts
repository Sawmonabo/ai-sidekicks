// The node's session directory, as the fixture derives it from one scenario.
//
// Split out of `fixture-growth-port.ts`, which serves it: the port's job is which
// operations are answered and with what outcome, and this module's job is a single
// question the port asks once — does the scenario declare a session this node HAS,
// and in what state. The two fail in different ways. The port is wrong when an
// operation answers where it should refuse; this derivation is wrong when a session
// that does not exist yet appears in a directory, or one that does goes missing.
//
// WHY IT READS THE SCRIPTED REPLY RATHER THAN THE BEATS
//
// A scenario's `session.read` reply is its statement of what that session IS, so the
// reply is where the state comes from. Lifting a state out of a beat's payload would
// have the fixture folding the event stream to re-derive a fact the scenario already
// states, and would disagree with the read the same window performs a moment later.

import type { GrowthSessionSummary } from "./growth-values.js";
import type { ConsoleScenario } from "./scenario.js";

/**
 * Session states that put a session in the node's directory.
 *
 * The directory answers what this node HAS, and `provisioning` is the state of a
 * session that is still being created — the one a first run is sitting in, and the
 * whole reason the first-run scenario exists. Listing it would make a freshly
 * installed console show a session row where `Spec-023 §Console Design (Meridian)`
 * §The five kinds of nothing requires the EMPTY kind: "no sessions yet", a stated
 * fact with a next action.
 *
 * An allow-list rather than a deny-list, so a state nobody has thought about yet
 * stays out of the directory rather than appearing in it by default. The directory
 * is the surface a person reads to find out what exists; the failure that matters
 * is a row for something that does not.
 */
const DIRECTORY_SESSION_STATES: ReadonlySet<string> = new Set(["active", "paused", "archived"]);

/**
 * The node's session directory, derived from what the scenario declares.
 *
 * Not "the scenario's session, always". `sessionId` is a required member of every
 * scenario because the beats and the reads are keyed on it, so its presence says
 * which session a scenario is ABOUT and says nothing about whether that session
 * exists yet — and answering with a row regardless made the first-run scenario, a
 * fresh install with nothing in it, list a session on the surface whose committed
 * screenshot baselines exist to pin the empty state.
 *
 * No title: a scenario declares none as a field, and lifting one out of a beat's
 * payload would have the fixture inventing a wire fact for the one surface that
 * renders it.
 */
export function directorySessionsOf(scenario: ConsoleScenario): readonly GrowthSessionSummary[] {
  const state = declaredSessionState(scenario);
  if (state === undefined || !DIRECTORY_SESSION_STATES.has(state)) {
    return [];
  }
  return [{ sessionId: scenario.sessionId, state } satisfies GrowthSessionSummary];
}

/**
 * The session state a scenario declares for its own session, if it declares one.
 *
 * `undefined` when the scenario scripts no session read: a scenario that declares
 * nothing about its session has not said the session exists, and inventing a state
 * for it here would be the fixture answering a question nobody asked it.
 */
function declaredSessionState(scenario: ConsoleScenario): string | undefined {
  const sessionRead = scenario.replies.find((reply) => reply.call === "session.read");
  // Read out of `unknown` by narrowing, the way the attention derivation reads a
  // beat's payload: a scenario's `result` is deliberately untyped so a scenario can
  // carry any registered reply, and a cast here would assert a shape the type system
  // was never given.
  return readSessionState(readMember(readMember(sessionRead?.result, "session"), "state"));
}

/** One member of a value that may not be an object at all. */
function readMember(value: unknown, member: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Readonly<Record<string, unknown>>)[member]
    : undefined;
}

function readSessionState(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
