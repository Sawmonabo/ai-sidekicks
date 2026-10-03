// What an act publishes: the shared arms, the three prerequisite states, and the pair
// published together. A dialog renders these types and never constructs the machine.

import type { Refusal } from "@renderer/lib/refusal.js";

/**
 * Where the question an act depends on stands. `not-read` means nobody has asked yet, as
 * distinct from asked and waiting for the reply. `refused` carries the service's own refusal of
 * the newest question.
 */
export type ActPrerequisiteReading<TValue> =
  | { readonly status: "not-read" }
  | { readonly status: "reading" }
  | { readonly status: "read"; readonly value: TValue }
  | { readonly status: "refused"; readonly refusal: Refusal };

/** The three statuses the act half owns. A settlement arm's discriminant is none of them. */
export type ActArmStatus = "idle" | "sending" | "refused";

/**
 * Where the act itself stands: three arms the act half owns, and the caller's own settled arm.
 * The caller names the settled arm (attached, bound, prepared) so each dialog reads its own
 * reply's members rather than an opaque payload. `refused` carries the service's own refusal,
 * and the control that sent the act is usable again.
 */
export type ActSettlementReading<TSettlement extends ActSettlementArm> =
  | { readonly status: "idle" }
  | { readonly status: "sending" }
  | { readonly status: "refused"; readonly refusal: Refusal }
  | TSettlement;

/**
 * What every settled arm has in common: a `status` discriminant of its own. The constraint
 * is wide because `Exclude<string, ActArmStatus>` is still `string`; a collision is refused
 * by {@link ActOwnArm} on the settle callback instead.
 */
export interface ActSettlementArm {
  readonly status: string;
}

/**
 * A settlement arm whose discriminant is its own, or `never`. Annotating the settle callback
 * with this makes an arm that reuses `idle`, `sending` or `refused` a compile error; it would
 * otherwise overwrite an owned state and render a settled act as still sending.
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
 * Nothing asked and nothing sent. One frozen value for every controller, typed at the
 * narrowest parameters so it is assignable wherever a reading is expected.
 */
export const ACT_NOT_STARTED: ActReading<never, never> = Object.freeze({
  prerequisite: PREREQUISITE_NOT_READ,
  act: ACT_IDLE,
});
