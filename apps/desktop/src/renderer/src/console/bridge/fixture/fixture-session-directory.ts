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

import type { SessionState } from "@ai-sidekicks/contracts";

import { ConsoleRefusalError, refuse } from "../../core/index.js";
import type { GrowthSessionSummary } from "../growth-values/index.js";
import { scriptedSessionReadMember } from "./scripted-session-read.js";
import type { ConsoleScenario } from "../scenario-runtime/index.js";

/** The subsystem a directory-derivation refusal names as its author. */
const DIRECTORY_ORIGIN = "fixture-session-directory";

/** Whether a session in one state appears in the node's directory. */
type DirectoryVisibility = "listed" | "hidden";

/**
 * Every registered session state, and whether the directory lists it.
 *
 * DERIVED FROM THE CONTRACT, NOT FROM A LIST WRITTEN HERE. The keys are
 * `SessionState`'s own six members (`packages/contracts/src/session.ts`), so a
 * state added to the wire is a compile error in this table until someone decides
 * what the directory does with it. The old allow-list was a free `Set<string>`
 * and had drifted in both directions at once: it admitted `paused`, which the
 * union has never contained, so a scenario could serve a row no daemon can send,
 * and it dropped `closed` and `purge_requested`, so a session that really exists
 * rendered as an empty directory.
 *
 * THE RULE, AND ITS SOURCE. No directory read is registered anywhere in the
 * corpus — `Plan-023 §Console growth slate` carries the row precisely because
 * `Spec-001` registers the `session.read` payloads and no list — so there is no
 * wire behaviour to mirror and the rule is this module's own, stated once: the
 * directory lists what this node HAS, which is every registered state except the
 * two ends of the lifecycle that are not a session anyone can open.
 *
 *   • `provisioning` is hidden because the session is still being created — the
 *     state a first run sits in, and the whole reason the first-run scenario
 *     exists. Listing it would make a freshly installed console show a session row
 *     where `Spec-023 §Console Design (Meridian)` §The five kinds of nothing
 *     requires the EMPTY kind: "no sessions yet", a stated fact with a next action.
 *   • `purged` is hidden because `Spec-022 §Required Behavior` makes the purge
 *     irreversible and its data gone; a row for it would name something to open
 *     that no longer has anything in it.
 *   • `purge_requested` is LISTED, on the same rule read the other way: that spec
 *     calls it a transient processing state in which "the session is locked
 *     against further modification while purge processing is pending". The session
 *     still exists, and hiding it would make a pending erasure invisible on the one
 *     surface that lists sessions.
 *   • `closed` and `archived` are listed for the plainest reason of all: the
 *     all-sessions list renders each row's "wire-verbatim `SessionState`"
 *     (`Spec-023 §Console Design (Meridian)` §The surface set), which is only a
 *     sentence about rows that reach it.
 */
const DIRECTORY_VISIBILITY_BY_SESSION_STATE: Readonly<Record<SessionState, DirectoryVisibility>> = {
  provisioning: "hidden",
  active: "listed",
  archived: "listed",
  closed: "listed",
  purge_requested: "listed",
  purged: "hidden",
};

/**
 * Whether a declared state is one the contract registers.
 *
 * Asked against the table above rather than against a second copy of the union,
 * which is what makes the exhaustiveness check load-bearing at runtime too.
 */
function isRegisteredSessionState(candidate: string): candidate is SessionState {
  return Object.hasOwn(DIRECTORY_VISIBILITY_BY_SESSION_STATE, candidate);
}

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
  if (state === undefined) {
    return [];
  }
  if (!isRegisteredSessionState(state)) {
    // A THROW rather than an empty directory, on `inline-card-seats.ts`' terms: a
    // scenario is in-tree source, so a state the wire cannot send is an authoring
    // defect, and answering `[]` would hide it behind the same empty directory a
    // first run legitimately produces.
    throw new ConsoleRefusalError(
      refuse(
        DIRECTORY_ORIGIN,
        "session-state-unregistered",
        `a scenario declared its session "${state}", which is not one of the ${String(Object.keys(DIRECTORY_VISIBILITY_BY_SESSION_STATE).length)} registered session states`,
      ),
    );
  }
  return DIRECTORY_VISIBILITY_BY_SESSION_STATE[state] === "hidden"
    ? []
    : [{ sessionId: scenario.sessionId, state } satisfies GrowthSessionSummary];
}

/**
 * The session state a scenario declares for its own session, if it declares one.
 *
 * `undefined` when the scenario scripts no session read: a scenario that declares
 * nothing about its session has not said the session exists, and inventing a state
 * for it here would be the fixture answering a question nobody asked it.
 */
function declaredSessionState(scenario: ConsoleScenario): string | undefined {
  // Read out of `unknown` by narrowing, the way the attention derivation reads a
  // beat's payload: a scenario's `result` is deliberately untyped so a scenario can
  // carry any registered reply, and a cast here would assert a shape the type system
  // was never given. The walk itself is `scripted-session-read.ts`', because the
  // snapshot derivation next door reads a different member of the same reply.
  const state = scriptedSessionReadMember(scenario, "session", "state");
  return typeof state === "string" ? state : undefined;
}
