// Conditional-type test against the `InterventionRequestResponse` arm scoping
// of `rejectionGuard`.
//
// The runtime suite (`__tests__/runControl.test.ts`, "the rejectionGuard
// member") proves the SCHEMA refuses the member on every arm but the rollback
// `rejected` one. That is a different claim from the one asserted here, and
// neither implies the other: `.strict()` refuses the member at the client's
// parse, but TypeScript's structural assignability lets a producer build the
// response in a variable, carry a stray `rejectionGuard` on it, and assign it
// to the union without a diagnostic — an object literal's excess-property
// check does not run on a non-fresh value. The `rejectionGuard?: never`
// members on the other arms are what turn that into a compile-time refusal at
// the construction site, and this file pins them.
//
// Every fixture below is deliberately a VARIABLE and not an inline literal, so
// each `@ts-expect-error` is exercising `?: never` and not freshness.
//
// Negative-test verification (run during the implementing task): delete any
// one arm's `rejectionGuard?: never` in `runControl.ts` and the matching
// `@ts-expect-error` below reports "Unused '@ts-expect-error' directive".

import type { InterventionId, InterventionRequestResponse } from "./runControl.js";

// Branded by assertion, as the runtime suite's own fixture is: this file makes
// a TYPE claim about the union's arms, not about the id's parser.
const base = {
  interventionId: "intervention-1" as InterventionId,
  runVersion: 5,
} as const;

const appliedCarryingGuard = {
  ...base,
  interventionType: "rollback",
  state: "applied",
  result: {
    disposition: "conversation-only",
    resendDisposition: "admitted",
  },
  rejectionGuard: "no-active-turn",
} as const;

const degradedCarryingGuard = {
  ...base,
  interventionType: "rollback",
  state: "degraded",
  result: {
    disposition: "nothing-applied",
    resendDisposition: "unapplied",
  },
  rejectionGuard: "no-active-turn",
} as const;

const expiredCarryingGuard = {
  ...base,
  interventionType: "rollback",
  state: "expired",
  rejectionGuard: "no-active-turn",
} as const;

const steerCarryingGuard = {
  ...base,
  interventionType: "steer",
  state: "rejected",
  rejectionReason: "run.invalid_transition",
  rejectionGuard: "no-active-turn",
} as const;

const rejectedCarryingGuard = {
  ...base,
  interventionType: "rollback",
  state: "rejected",
  rejectionReason: "run.invalid_transition",
  rejectionGuard: "no-active-turn",
} as const;

// @ts-expect-error — the applied arm declares `rejectionGuard?: never`.
export const appliedResponse: InterventionRequestResponse = appliedCarryingGuard;

// @ts-expect-error — the degraded arm declares `rejectionGuard?: never`.
export const degradedResponse: InterventionRequestResponse = degradedCarryingGuard;

// @ts-expect-error — the non-disposition arm declares `rejectionGuard?: never`.
export const expiredResponse: InterventionRequestResponse = expiredCarryingGuard;

// @ts-expect-error — only a rollback request can be a composite.
export const steerResponse: InterventionRequestResponse = steerCarryingGuard;

// Positive control: the one arm that carries the guard accepts it off the same
// non-fresh shape, so the four refusals above are the `never`s and not a
// mismatch elsewhere in the fixtures.
export const rejectedResponse: InterventionRequestResponse = rejectedCarryingGuard;
