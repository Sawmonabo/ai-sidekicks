// What an act publishes, and the vocabulary a surface reads it in.
//
// SPLIT FROM `act-controller.ts` BESIDE IT along the seam that module's own size made
// visible: this is what a CONSUMER names — the three arms every act shares, the four
// states its prerequisite question stands in, and the pair published together — while
// the class beside it owns when each is written. A surface renders these types and
// never constructs the machine, so the two travel separately.
//
// THE SETTLED ARM IS DELIBERATELY THE CALLER'S. What a person reads off a finished act
// is "attached", "bound", "prepared" — the verb of the thing they did, carrying the
// members that act's own reply carries. One shared `settled` arm would have made every
// surface say the same word about a different act and read its reply back out of an
// opaque payload.

import type { ConsoleRefusal } from "../core/index.js";

/**
 * What a wire call answers with: the value, or the refusal standing in its place.
 *
 * Declared here rather than imported, because `bridge/daemon/daemon-reply.ts`'s
 * `DaemonReply` sits ABOVE this family in the console's DAG and this module may not
 * name it. It is the same shape, so every call wrapper in the tree already satisfies
 * this without an adapter — which is the point: the seam is structural, so nothing
 * converts a reply on the way in.
 */
export type ActOutcome<TValue> =
  | { readonly status: "served"; readonly value: TValue }
  | { readonly status: "refused"; readonly refusal: ConsoleRefusal };

/**
 * Where the question an act depends on stands, in the four states rule 8 keeps apart.
 *
 * `not-read` is a real answer and not an omission: nobody has asked yet, which is
 * different from having asked and being told no.
 */
export type ActPrerequisiteReading<TValue> =
  | { readonly status: "not-read" }
  | { readonly status: "reading" }
  | { readonly status: "read"; readonly value: TValue }
  | { readonly status: "refused"; readonly refusal: ConsoleRefusal };

/**
 * Where the act itself stands: three arms this class owns, and the caller's own.
 *
 * THE SETTLED ARM IS THE CALLER'S BECAUSE THE SETTLEMENT IS THE CALLER'S. What a
 * person reads off a finished act is "attached", "bound", "prepared" — the verb of the
 * thing they did, carrying the members that act's reply carries. A shared `settled`
 * arm would have made every surface say the same word about a different act and read
 * its own reply back out of an opaque payload.
 */
export type ActSettlementReading<TSettlement extends ActSettlementArm> =
  | { readonly status: "idle" }
  | { readonly status: "sending" }
  | { readonly status: "refused"; readonly refusal: ConsoleRefusal }
  | TSettlement;

/**
 * What every settled arm has in common, and the whole of what this module requires
 * of one: a `status` discriminant that is not one of the three arms above it.
 */
export interface ActSettlementArm {
  readonly status: string;
}

/** Both halves, published together so a surface renders one consistent frame. */
export interface ActReading<TValue, TSettlement extends ActSettlementArm> {
  readonly prerequisite: ActPrerequisiteReading<TValue>;
  readonly act: ActSettlementReading<TSettlement>;
}

/**
 * Nothing asked and nothing sent.
 *
 * One frozen value for every controller, typed at the narrowest parameters so it is
 * assignable wherever a reading is expected: both halves are covariant in what they
 * carry, and neither of this value's arms carries anything.
 */
export const ACT_NOT_STARTED: ActReading<never, never> = Object.freeze({
  prerequisite: Object.freeze({ status: "not-read" as const }),
  act: Object.freeze({ status: "idle" as const }),
});
