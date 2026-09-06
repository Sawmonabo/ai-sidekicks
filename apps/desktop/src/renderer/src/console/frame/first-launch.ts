// What a console opens into the very first time somebody launches it.
//
// `Spec-023 §The four bars`, Richness, names the composition — "The first sixty
// seconds and the flagship frame are designed compositions, regression-tested by
// screenshot" — and the scenario that composes it has existed since the ledger
// family landed. What did not exist was any route into it: a fresh console opened at
// the sessions list, so the one surface designed to demonstrate the product before
// asking for anything was reachable only by typing a fixture id into a query string.
//
// THE RULE, AND ITS FOUR CONJUNCTS. A window opens into the demo session when all
// four hold, and at the sessions list otherwise:
//
//   1. **The window was born at no route.** A hash naming one is a route a person or
//      a reload asked for, and overriding it would take somebody back to a demo they
//      had left. `parseRoute("")` answers the default, so "asked for nothing" is
//      tested on the HASH rather than on the route it parsed to — the two are the
//      same value and only one of them is evidence.
//   2. **A scenario is playing.** The demo IS a fixture scenario, so a release build
//      has no session to open into and this returns nothing. That is what keeps the
//      live bridge's first-run frame exactly what it was, and it is a property of the
//      bridge that resolved rather than an environment check: the fixture is a
//      `define`-gated build constant, and a window whose bridge carries no engine is
//      one this rule has nothing to offer.
//   3. **That scenario is the DEFAULT opening.** Nobody named it — it is what a window
//      plays when the launch says nothing. A named scenario is an ask exactly as a
//      named route is, and it is asked for by the people this rule must not fight: a
//      suite pinning the empty first-run composition, the picker opening one
//      deliberately. Testing the id rather than "some scenario is playing" is what
//      makes the difference legible, since EVERY scenario scripts a session — the
//      first-run one included — so a session's existence cannot tell the two apart.
//   4. **This install has not seen it.** Once is the whole point — the demo is how a
//      console introduces itself, and a console that reintroduced itself on every
//      launch would be a tour, which `Spec-023` and the design both refuse.
//
// WHY THE MARK IS A `selection` AND NOT A CLASS OF ITS OWN. The durable store's value
// classes are closed at seven and each is a KIND of UI state rather than a feature's
// name; this is the window remembering which of two openings it chose, which is what
// that class already holds elsewhere. A class minted for one boolean would be an
// eighth name in a closed enumeration every consumer derives from, for a fact the
// existing seven already describe.
//
// AND WHY IT IS GLOBAL RATHER THAN PARTITIONED. It is a fact about the INSTALL, not
// about a session: partitioned by session it would be written under the demo's own id
// and a second scenario would reintroduce the console all over again.

import { DEFAULT_SCENARIO_ID } from "../bridge/index.js";
import { DEFAULT_ROUTE, parseRoute, type ConsoleRoute } from "../routing/index.js";

/** The durable key the mark is written under, in the store's global partition. */
export const FIRST_LAUNCH_SEEN_KEY = "first-launch-seen";

/** The class the mark is written as — see the module header for why this one. */
export const FIRST_LAUNCH_SEEN_VALUE_CLASS = "selection" as const;

/**
 * What is stored under that key: the identifier of the opening this install saw.
 *
 * A record rather than a bare `true` because the `selection` class validates that
 * shape — an object keyed by identifier, whose values are identifiers — and because a
 * record naming WHAT was seen survives a second opening being remembered later,
 * where a boolean would have to be re-read as "seen something".
 */
export const FIRST_LAUNCH_SEEN_VALUE: { readonly [key: string]: string } = {
  opening: "first-sixty-seconds",
};

/**
 * Whether a record read back under that key says this install has seen the demo.
 *
 * The PRESENCE of the record is the mark, and this reads no member of it: the store
 * answers `undefined` for a key nothing wrote and for a read it could not perform,
 * and both of those mean the same thing here — nothing established that this console
 * has introduced itself. Erring toward showing the demo again is the safe direction:
 * the cost is one extra viewing, and the cost the other way is a first launch that
 * silently skipped the one surface designed for it.
 */
export function hasSeenFirstLaunch(storedRecord: unknown): boolean {
  return storedRecord !== undefined;
}

export interface FirstLaunchInputs {
  /** The hash the window was BORN at — never a later one. */
  readonly openedAtHash: string;
  /** The playing scenario's session, or `undefined` where no scenario is playing. */
  readonly demoSessionId: string | undefined;
  /**
   * The playing scenario's id, or `undefined` where no scenario is playing.
   *
   * Carried beside the session rather than derived from it: two scenarios may script
   * one session id, and which composition is playing is the question conjunct 3 asks.
   */
  readonly playingScenarioId: string | undefined;
  /** Whether this install has already been shown the demo. */
  readonly hasSeenFirstLaunch: boolean;
}

/**
 * Where a window should open, or `undefined` when nothing about it is special.
 *
 * `undefined` rather than the default route, and the difference is what the caller
 * does with it: an answer of "the sessions list" would be this rule NAVIGATING every
 * ordinary launch to a route the window is already at, which fights the hash binding
 * for the same fact. Nothing to say is said by saying nothing.
 */
export function firstLaunchRoute(inputs: FirstLaunchInputs): ConsoleRoute | undefined {
  if (
    inputs.hasSeenFirstLaunch ||
    inputs.demoSessionId === undefined ||
    inputs.playingScenarioId !== DEFAULT_SCENARIO_ID
  ) {
    return undefined;
  }
  return openedAtNoRoute(inputs.openedAtHash)
    ? { kind: "workspace", sessionId: inputs.demoSessionId }
    : undefined;
}

/**
 * Whether the opening hash asked for nothing.
 *
 * Compared against what an EMPTY hash parses to rather than against the route the
 * window is at: `#/sessions` and `` reach the same route, and only one of them is a
 * person asking for the sessions list. An explicit hash is an ask and is honoured.
 */
function openedAtNoRoute(openedAtHash: string): boolean {
  const trimmed = openedAtHash.replace(/^#/, "");
  return trimmed === "" && parseRoute(openedAtHash).kind === DEFAULT_ROUTE.kind;
}
