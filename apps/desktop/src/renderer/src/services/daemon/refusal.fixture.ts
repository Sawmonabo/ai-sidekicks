// Why the fixture could not answer, and the one exception that says so. A `FixtureBridgeError`
// says the fixture could not answer (nothing scripted, no stand-in for a native capability, the
// engine torn down under the request); a scripted `ScenarioRejectingReply` says the daemon refused
// and travels as the wire's own `{code, message}` envelope, unwrapped. They stay two values, since
// merging them would put a fixture-scoped code in front of every typed daemon refusal. It is its
// own module so the daemon fixture, its subscriptions and the platform fixture each read one leaf.

import { RefusalError, refuse } from "#renderer/lib/refusal/refusal.js";

/**
 * The codes a scripted reply that never arrived refuses with. Each is a distinct remedy:
 * `reply-abandoned` means the engine was torn down before the frozen clock reached the reply
 * (advance it before disposing), and `reply-backlog-full` means more delayed replies, or notices
 * those replies push, were parked than the cap admits without the clock moving.
 */
const SCRIPTED_REPLY_REFUSAL_CODES = ["reply-abandoned", "reply-backlog-full"] as const;

/** One such code, derived from the list. */
export type ScriptedReplyRefusalCode = (typeof SCRIPTED_REPLY_REFUSAL_CODES)[number];

/**
 * Why the fixture could not answer. Rendered verbatim; never swallowed.
 *
 * `reply-unscripted` is an authoring gap: the scenario scripts no reply for a registered method.
 * `beat-unprojectable` is an authoring error: the beat names a kind a narrowed stream carries but
 * cannot supply the required payload, and it refuses rather than deliver a half-built projection.
 * `reply-off-contract` is the same on the call seam: a scripted reply does not match the shape
 * `#shared/daemon/daemon-method-bindings.ts` binds to its method, or a notice it pushes does not
 * match the shape its stream registers, and delivering either would teach a view to render a frame
 * production never produces. The last two name a reply the frozen clock never released, or a notice
 * it could not park.
 */
export const FIXTURE_BRIDGE_REFUSAL_CODES: readonly [
  "reply-unscripted",
  "capability-absent",
  "beat-unprojectable",
  "reply-off-contract",
  ...typeof SCRIPTED_REPLY_REFUSAL_CODES,
] = [
  "reply-unscripted",
  "capability-absent",
  "beat-unprojectable",
  "reply-off-contract",
  ...SCRIPTED_REPLY_REFUSAL_CODES,
];

/** One fixture refusal code, derived from `FIXTURE_BRIDGE_REFUSAL_CODES`. */
export type FixtureBridgeRefusalCode = (typeof FIXTURE_BRIDGE_REFUSAL_CODES)[number];

/** The subsystem name every refusal this module raises carries. */
export const FIXTURE_BRIDGE_REFUSAL_ORIGIN = "fixture-bridge";

/**
 * Thrown when a caller asks the fixture for something no scenario scripts.
 *
 * A `RefusalError`, so the one refusal renderer needs no translation, and a named subclass so a
 * fixture failure can be caught by name; it travels as an exception because the preload contract
 * fixes the signatures. `call` names the bridge method as machine-readable provenance, apart from
 * `detail`, the sentence a person acts on.
 */
export class FixtureBridgeError extends RefusalError {
  public readonly call: string;

  public constructor(call: string, code: FixtureBridgeRefusalCode, detail: string) {
    super(refuse(FIXTURE_BRIDGE_REFUSAL_ORIGIN, code, `${call} — ${detail}`));
    this.name = "FixtureBridgeError";
    this.call = call;
  }
}

/**
 * Reject one call the fixture cannot stand in for. Not named `refuse`, which is
 * `lib/refusal/refusal.ts`'s builder imported above.
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
