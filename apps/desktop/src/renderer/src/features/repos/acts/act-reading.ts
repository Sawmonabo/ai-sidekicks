// What an act publishes, and the vocabulary a dialog reads it in.
//
// Split from `act-controller.ts` beside it: this is what a CONSUMER names — the two arms
// every act shares, the three states its prerequisite question stands in, and the pair
// published together — while the classes beside it own when each is written. A dialog
// renders these types and never constructs the machine, so the two travel separately.

/**
 * Where the question an act depends on stands.
 *
 * `not-read` is a real answer and not an omission: nobody has asked yet, which is
 * different from having asked and waiting for the reply.
 */
export type ActPrerequisiteReading<TValue> =
  | { readonly status: "not-read" }
  | { readonly status: "reading" }
  | { readonly status: "read"; readonly value: TValue };

/** The two statuses the act half owns. A settlement arm's discriminant is neither of them. */
export type ActArmStatus = "idle" | "sending";

/**
 * Where the act itself stands: two arms the act half owns, and the caller's own.
 *
 * THE SETTLED ARM IS THE CALLER'S BECAUSE THE SETTLEMENT IS THE CALLER'S. What a
 * person reads off a finished act is "attached", "bound", "prepared" — the verb of the
 * thing they did, carrying the members that act's reply carries. A shared `settled`
 * arm would have made every dialog say the same word about a different act and read
 * its own reply back out of an opaque payload.
 */
export type ActSettlementReading<TSettlement extends ActSettlementArm> =
  | { readonly status: "idle" }
  | { readonly status: "sending" }
  | TSettlement;

/**
 * What every settled arm has in common: a `status` discriminant of its own.
 *
 * THE CONSTRAINT IS DELIBERATELY WIDE AND THE NEGATION IS {@link ActOwnArm}'S.
 * `Exclude<string, ActArmStatus>` is `string` — subtraction over a primitive removes
 * nothing — so an interface here cannot say "any string but those two", and one
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
 * TypeScript can evaluate: `Extract` of the arm's status against the two owned ones is
 * empty exactly when there is no collision, and an arm that reuses `idle` or `sending`
 * resolves to `never` instead. Annotating the settle callback with this makes such an
 * arm a compile error at the one place it could be published — a controller would
 * otherwise silently overwrite one of the two states the reading is read in, and a
 * settled act would render as still sending.
 */
export type ActOwnArm<TSettlement extends ActSettlementArm> =
  Extract<TSettlement["status"], ActArmStatus> extends never ? TSettlement : never;

/** Both halves, published together so a dialog renders one consistent frame. */
export interface ActReading<TValue, TSettlement extends ActSettlementArm> {
  readonly prerequisite: ActPrerequisiteReading<TValue>;
  readonly act: ActSettlementReading<TSettlement>;
}

/** Nothing sent. The act half's reading before its first act. */
export const ACT_IDLE: ActSettlementReading<never> = Object.freeze({ status: "idle" as const });

/** Nothing asked. The prerequisite half's reading before its first question. */
export const PREREQUISITE_NOT_READ: ActPrerequisiteReading<never> = Object.freeze({
  status: "not-read" as const,
});

/**
 * Nothing asked and nothing sent.
 *
 * One frozen value for every controller, typed at the narrowest parameters so it is
 * assignable wherever a reading is expected: both halves are covariant in what they
 * carry, and neither of this value's arms carries anything.
 */
export const ACT_NOT_STARTED: ActReading<never, never> = Object.freeze({
  prerequisite: PREREQUISITE_NOT_READ,
  act: ACT_IDLE,
});
