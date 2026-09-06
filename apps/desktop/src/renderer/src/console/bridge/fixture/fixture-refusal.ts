// Why the fixture could not answer, and the one exception that says so.
//
// A scenario may also script a call that REFUSES, and the two refusal vocabularies
// here are deliberately different values rather than one merged shape. A
// `FixtureBridgeError` says the FIXTURE could not answer (nothing scripted, no
// stand-in for a native capability, the engine torn down under the request); a
// scripted `ScenarioRejectingReply` says the DAEMON refused, and travels as the
// wire's own `{code, message}` envelope, unwrapped. Folding the second into the
// first would put a fixture-scoped code in front of every typed daemon refusal the
// console renders, which is the one thing a fixture must not paraphrase.
//
// ITS OWN MODULE because both fixture doors raise it and the bridge that composes them
// imports both. A vocabulary declared in the bridge and thrown from the doors would
// close an import cycle through the module every console surface reaches the fixture
// by; declared here, the doors and the bridge all read one leaf and none of them reads
// another.

import { ConsoleRefusalError, refuse } from "../../core/index.js";
import {
  SCRIPT_ABSENT_REFUSAL_CODE,
  SCRIPTED_REPLY_REFUSAL_CODES,
} from "../scenario-runtime/scripted-reply.js";

/**
 * Why the fixture could not answer. Rendered verbatim; never swallowed.
 *
 * The first and the last two come from `scripted-reply.ts` rather than being spelled
 * again here: the last two name a reply the frozen clock never released, which is a
 * fact about the seam both fixture surfaces share, and the growth port's own closed
 * set spreads the same two. The first is that module's `SCRIPT_ABSENT_REFUSAL_CODE`,
 * which `growth-port.ts` and `growth-outcome.ts` also read by name, so the value is
 * written once and the two vocabularies cannot drift apart under a rename.
 *
 * `beat-unprojectable` is a SCENARIO authoring error rather than a wire one: the
 * beat named a kind a narrowed stream carries and then could not supply what that
 * stream's registered payload requires. It refuses rather than delivering the half
 * it could build, because a projection missing a required member renders as blank
 * and reviews as working.
 *
 * `reply-off-contract` is the other half of that authoring claim, on the request /
 * response seam rather than the subscription one: the scenario scripted a reply for
 * a method the corpus HAS registered, and the value does not match the shape
 * `daemon-reply-registry.ts` binds to it. It refuses rather than resolving, because
 * a fixture that hands a surface a shape the live wire cannot send teaches that
 * surface to render a frame production never produces — the same defect the
 * projection arm above exists to prevent, arriving through the call door.
 */
export const FIXTURE_BRIDGE_REFUSAL_CODES: readonly [
  typeof SCRIPT_ABSENT_REFUSAL_CODE,
  "capability-absent",
  "beat-unprojectable",
  "reply-off-contract",
  ...typeof SCRIPTED_REPLY_REFUSAL_CODES,
] = [
  SCRIPT_ABSENT_REFUSAL_CODE,
  "capability-absent",
  "beat-unprojectable",
  "reply-off-contract",
  ...SCRIPTED_REPLY_REFUSAL_CODES,
];

/** One fixture refusal code. Derived, so the vocabulary is declared exactly once. */
export type FixtureBridgeRefusalCode = (typeof FIXTURE_BRIDGE_REFUSAL_CODES)[number];

/** The subsystem name every refusal this module raises carries. */
export const FIXTURE_BRIDGE_REFUSAL_ORIGIN = "fixture-bridge";

/**
 * Thrown when a surface asks the fixture for something no scenario scripts.
 *
 * A `ConsoleRefusalError` and not a bare `Error` carrying a code of its own.
 * `core/refusal.ts` names this module as one of the five that had minted their own
 * refusal vocabulary, and the cost was concrete: a surface wanting to render a
 * fixture failure beside a growth-port one had to translate between two shapes to
 * reach one renderer. It stays a NAMED subclass because a fixture failure is worth
 * catching by name — the seam has to travel as an exception, since these are
 * rejections from methods whose signatures the preload contract fixes.
 *
 * `call` is kept beside the refusal rather than folded into `detail`: it names a
 * bridge method, which is machine-readable provenance, and `detail` is the sentence
 * a person acts on.
 */
export class FixtureBridgeError extends ConsoleRefusalError {
  public readonly call: string;

  public constructor(call: string, code: FixtureBridgeRefusalCode, detail: string) {
    super(refuse(FIXTURE_BRIDGE_REFUSAL_ORIGIN, code, `${call} — ${detail}`));
    this.name = "FixtureBridgeError";
    this.call = call;
  }
}

/**
 * Reject one call the fixture cannot stand in for.
 *
 * Named for what it refuses rather than `refuse`, which is `core/refusal.ts`'s
 * builder and is imported above: two functions called `refuse` in one module, one
 * returning a refusal and one rejecting with it, is the kind of collision a reader
 * resolves wrongly once and then trusts.
 */
export function refuseAbsentCapability(call: string): Promise<never> {
  return Promise.reject(
    new FixtureBridgeError(
      call,
      "capability-absent",
      "this capability needs the real main process and has no fixture stand-in",
    ),
  );
}
