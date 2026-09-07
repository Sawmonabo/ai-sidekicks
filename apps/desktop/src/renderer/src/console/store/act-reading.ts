// What an act publishes, and the vocabulary a surface reads it in.
//
// SPLIT FROM `act-controller.ts` BESIDE IT along the seam that module's own size made
// visible: this is what a CONSUMER names — the three arms every act shares, the four
// states its prerequisite question stands in, and the pair published together — while
// the class beside it owns when each is written. A surface renders these types and
// never constructs the machine, so the two travel separately.

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

/** The three statuses this module owns. A settlement arm's discriminant is none of them. */
export type ActArmStatus = "idle" | "sending" | "refused";

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
 * What every settled arm has in common: a `status` discriminant of its own.
 *
 * THE CONSTRAINT IS DELIBERATELY WIDE AND THE NEGATION IS {@link ActOwnArm}'S.
 * `Exclude<string, ActArmStatus>` is `string` — subtraction over a primitive removes
 * nothing — so an interface here cannot say "any string but those three", and one
 * written as though it could would be a comment claiming a check nobody performs.
 * What this requires is the discriminant; what refuses a collision is the type the
 * settle callback is annotated with, where a bad arm actually enters.
 */
export interface ActSettlementArm {
  readonly status: string;
}

/**
 * A settlement arm whose discriminant is genuinely its own, or `never`.
 *
 * WRITTEN AS A COLLISION TEST RATHER THAN AS A SUBTRACTION, which is the only form
 * TypeScript can evaluate: `Extract` of the arm's status against the three owned ones
 * is empty exactly when there is no collision, and an arm that reuses `idle`,
 * `sending`, or `refused` resolves to `never` instead. Annotating the settle callback
 * with this makes such an arm a compile error at the one place it could be published —
 * a surface would otherwise silently overwrite one of the three states the reading is
 * read in, and a settled act would render as still sending.
 */
export type ActOwnArm<TSettlement extends ActSettlementArm> =
  Extract<TSettlement["status"], ActArmStatus> extends never ? TSettlement : never;

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
