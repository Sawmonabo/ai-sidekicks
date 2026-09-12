// A scenario: the script the fixture bridge plays, held as DATA.
//
// The fixture bridge serves scripted scenarios over async generators with a frozen
// clock, and that clock is the only one the renderer reads in fixture mode.
//
// A scenario is therefore DATA, not code: an ordered script of events with the
// millisecond each is due, plus canned replies for request/response calls. That
// matters for two reasons beyond tidiness — a data scenario can be asserted against
// (the screenshot tier pins a frame by advancing to an exact tick), and a scenario
// that cannot reach the network or the clock cannot accidentally become flaky.
//
// WHAT IS NOT HERE. The engine that plays one, which is `scenario-engine.ts`. The
// two were one file until the seam this package's module rules split on
// was drawn between them, and that seam is exactly this one — WHAT a scenario
// is, against HOW it is played. The split is load-bearing rather than tidy: a seat
// board, the scenario manifest, and the wire-truth predicate that holds every scenario
// to the wire's own truth all DESCRIBE scenarios and play none, so they stop here
// and never reach the engine's teardown rules or its held-reply queue.
//
// AND THE REPLY TABLE IS NOT HERE EITHER, for that same rule applied a second time:
// `scenario-reply.ts` owns how one request/response CALL settles — the three arms, the
// refusal shape, and what a computed reply is handed — which is a different question
// from who this scenario is about and what it plays, and the module that settles one
// reply and the walk that audits every one of them both stop there.
//
// AND THE FRAME FAMILIES ARE NOT HERE EITHER, for the same rule one level down. What
// a reader opens this file for is the scenario's SHAPE — who is in it, what it
// answers, what it plays — and each family of tick-scheduled readings carries a page
// of its own reasoning in front of that. `frames.ts` holds the roster, the activity,
// the shell condition and the transport outage; it is read by the fixture namespace
// that resolves it and re-exported from this directory's door beside the shape
// below.

import type { UpdateState } from "@ai-sidekicks/contracts";

// Type-only, and into a subtree the console ABSORBS rather than one that mounts into
// it — `.dependency-cruiser.mjs`'s `console-not-plan-subtree` names the three absorbed
// families as the deliberate exception. The alias is `RuntimeNodeAttachRequest` minus
// its session id, derived from the shipped contract by construction, so restating its
// shape here would be a second spelling of one wire fact.
import type { RuntimeNodeAttachDraft } from "../../../../runtime-node-attach/index.js";
import type { ConsoleSessionEvent } from "../../../store/index.js";
import type {
  ScenarioActivityFrame,
  ScenarioRuntimeNodeRosterFrame,
  ScenarioShellStatusFrame,
  ScenarioTransportOutage,
} from "./frames.js";
import type { ScenarioReply } from "./reply.js";
import type { ScriptedSignInCeremony } from "../../web-authn/ceremony-outcome.js";

/** One scripted event and the tick it is due at, measured from scenario start. */
export interface ScenarioBeat {
  readonly atMs: number;
  readonly event: ConsoleSessionEvent;
}

export interface ConsoleScenario {
  readonly id: string;
  /** Shown in the fixture picker. Short; a name, not a sentence. */
  readonly label: string;
  /** What this scenario is for, so a reader knows which to reach for. */
  readonly purpose: string;
  readonly sessionId: string;
  /** Users in join order — the hue allocator's input (rule 2). */
  readonly userIdsInJoinOrder: readonly string[];
  /**
   * Which of those users this window IS, where the scenario states one.
   *
   * OPTIONAL, and the optionality is the point: join order is who opened the session
   * and who followed, so reading its head as "me" is a fabrication — and a surface
   * handed a fabricated identity attributes rows to somebody who is not looking. A
   * scenario that does not say leaves this absent and the fixture refuses the
   * caller-identity read, which is the honest "not checked" answer.
   *
   * When present it must be one of `userIdsInJoinOrder`: an identity outside
   * that list is a viewer of some other session, and every surface that resolves it
   * would look it up and find nothing. `scenario/wire-truth/wire-truth.ts` holds every
   * scenario to that, the substrate's own two included.
   */
  readonly viewingUserId?: string;
  readonly beats: readonly ScenarioBeat[];
  readonly replies: readonly ScenarioReply[];
  /**
   * Whether this scenario's daemon refuses a resume position the console submits.
   *
   * A BOOLEAN AND NOT THE CURSOR ITSELF, because the cursor is already stated once —
   * a scenario's `session.read` reply carries the acknowledged position, the store
   * submits exactly that string on its next read, and a second copy of it here would
   * be one value in two places, silently unreachable the moment they drifted. So the
   * scenario declares the DISPOSITION and the fixture applies it to whatever position
   * arrives.
   *
   * It is a scenario member rather than a `replies` row because the reply table
   * answers a call with one fixed value, and this refuses one ARM of a call — a read
   * carrying a position — while the same call with no position is served in the same
   * scenario, which is what makes the console's recovery observable at all.
   *
   * OPTIONAL, and its absence means the ordinary thing: this daemon resolves what it
   * acknowledged. A scenario that scripts no acknowledged position submits nothing and
   * is unaffected either way.
   */
  readonly refusesSubmittedResumeCursor?: boolean;
  /**
   * The session's runtime-node roster as it reads over scenario time.
   *
   * OPTIONAL, and the optionality is the answer rather than a gap: a scenario that
   * names no roster has not been asked, so the read refuses with the "not checked"
   * absence instead of resolving with an empty set. Those are different facts — "no
   * machine is attached" is a session state a surface draws, and "nobody asked" is
   * not — and a fixture that conflated them would train the roster to render an
   * empty table for a read that never happened.
   *
   * It is a scenario member rather than a `replies` row because the reply table is
   * keyed by call name and answers each call with one fixed value, which cannot
   * express a roster that moves. A scenario needing latency or a scripted daemon
   * refusal for some other call still uses `replies`; this member is the one read
   * whose ANSWER is a function of the clock.
   */
  readonly runtimeNodeRoster?: readonly ScenarioRuntimeNodeRosterFrame[];
  /**
   * The declaration a local runtime node would make about itself, where the scenario
   * states one.
   *
   * OPTIONAL, and the absence is the honest answer rather than a gap: the attach
   * declaration is a machine's claim about its own identity, contract version, health
   * and capabilities, and its composition belongs in the main process, off the node
   * registry — never in a renderer, which may not vouch for a machine on its own
   * word. A scenario that names none leaves the attach control
   * unmountable and the surface says so, which is exactly what a window with no such
   * registry behind it should say.
   *
   * Here rather than in a `replies` row because a reply is what the daemon ANSWERS and
   * this is what the caller SENDS — the reply table is keyed by call name and would
   * have to hold a request under the name of a mutation.
   */
  readonly runtimeNodeAttachDraft?: RuntimeNodeAttachDraft;
  /**
   * What the shell's updater reports, where the scenario states one.
   *
   * OPTIONAL, and the default is the one the fixture answered before this member
   * existed: a bare `idle` carrying no last-check instant. That default is load-
   * bearing rather than incidental — `UpdateState`'s `idle` arm carries an optional
   * `lastCheckedAt`, and a fixture that supplied one on every scenario would make
   * the never-checked arm unreachable in the deck, which is the arm a fresh install
   * is actually in.
   *
   * The updater is a SHELL surface rather than a daemon one, so it is a scenario
   * member and not a `replies` row: the reply table is keyed by daemon method or
   * control-plane procedure name, and `update.getState` is neither.
   */
  readonly updaterState?: UpdateState;
  /**
   * When this window's transport is lost and when it comes back, in scenario time.
   *
   * The fixture's half of the console's one transport-reconnect signal
   * (`bridge/transport/transport-reconnect.ts`): a scenario that names an outage
   * drives the signal through `unreachable` and back, and every reading wired to it
   * re-reads on the returning edge. A scenario that names none never reports a
   * reconnect, which is the honest reading of a window whose wire never went away.
   */
  readonly transportOutages?: readonly ScenarioTransportOutage[];
  /**
   * The session's live activity as it reads over scenario time.
   *
   * OPTIONAL, and the optionality is the answer rather than a gap — the roster
   * member's reading, applied here: a scenario that names no activity has not been
   * asked, so the read refuses with the "not checked" absence instead of resolving
   * with two empty lists. A scenario that DOES name activity and states a frame with
   * both lists empty has been asked and answered, and the indicators render nothing,
   * which is their ordinary state.
   */
  readonly activity?: readonly ScenarioActivityFrame[];
  /**
   * The shell's own condition as it reads over scenario time.
   *
   * OPTIONAL on {@link runtimeNodeRoster}'s reasoning, and the optionality carries
   * the same meaning: a scenario that names no frames has not been asked, so the
   * subscription refuses with the "not checked" absence instead of opening a stream
   * that would report a connected shell nobody scripted. It is a scenario member
   * rather than a `replies` row for that module's other reason — the reply table
   * answers one call with one fixed value, and this is a feed.
   */
  readonly shellStatus?: readonly ScenarioShellStatusFrame[];
  /**
   * What this host's WebAuthn ceremony answers, where the scenario states it.
   *
   * OPTIONAL on the `runtimeNodeRoster` reading: a scenario that says nothing has
   * not been asked, so the fixture refuses the ceremony exactly as it refuses every
   * other native capability it cannot stand in for, and the sign-in surface renders
   * the "not checked" absence. That is the honest state of a build with no ceremony,
   * and it is also the state the shipped stub preload is in.
   *
   * A SCENARIO MEMBER RATHER THAN A `replies` ROW because `reply-walk.ts` admits a
   * reply keyed only on a registered daemon method or a growth operation id, and the
   * ceremony is neither — it is a preload-bridge namespace the contract already
   * declares. It is also a fact about the HOST rather than about the session: which
   * authenticator this machine has, whether it does PRF, and whether the OS keystore
   * will hold what the ceremony mints.
   *
   * The type excludes this console's own `unavailable` arm, so a scenario cannot
   * script "there is no ceremony here" as though a host had answered it — that arm
   * is a reading the adapter makes when nothing answered at all. It carries a
   * SEQUENCE of assertion answers rather than one, for the reason its own declaration
   * states: the device grant's settlement arrives as a second assertion.
   */
  readonly signInCeremony?: ScriptedSignInCeremony;
  /** Wall-clock instant the frozen clock reports as "now" at tick zero. */
  readonly startedAtIso: string;
}
