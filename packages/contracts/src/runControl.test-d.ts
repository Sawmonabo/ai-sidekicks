// Conditional-type tests against two `runControl.ts` shapes the runtime suite
// cannot reach: the `InterventionRequestResponse` arm scoping of
// `rejectionGuard`, and the `steer` arm's `ArtifactId[]` attachment element.
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

import type { ArtifactId, RunId } from "./provider-driver.js";
import type {
  InterventionId,
  InterventionRequestPayload,
  InterventionRequestResponse,
} from "./runControl.js";

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

// --------------------------------------------------------------------------
// The `steer` arm's attachment element type
// --------------------------------------------------------------------------
//
// The runtime suite proves the SCHEMA refuses a non-id element. That is again a
// different claim: a producer composing the payload in TypeScript never reaches
// the parser, and before the 2026-09-08 discharge the arm was `unknown[]`, so a
// `string[]` of unvalidated ids — or an array of anything at all — assigned
// cleanly. `ArtifactId` is a BRANDED string, so the assignments below are what
// make an unbranded id a compile-time error at the construction site rather
// than a runtime refusal at the far end of the wire.
//
// Negative-test verification (run during the implementing task): widen the arm
// back to `unknown[]` in `runControl.ts` and both `@ts-expect-error` directives
// below report "Unused '@ts-expect-error' directive".

const steerBase = {
  type: "steer",
  targetRunId: "0f2b4d5e-6666-4666-8666-666666666666" as RunId,
  expectedRunVersion: 5,
  clientIdempotencyKey: "0f2b4d5e-9999-4999-8999-999999999999",
  content: "see the attached trace",
} as const;

// Deliberately NOT `as const` below `steerBase`: `as const` would make each
// `attachments` a READONLY TUPLE, and a readonly array is unassignable to a
// mutable `ArtifactId[]` whatever its element type — which would make even the
// positive control fail and turn both `@ts-expect-error`s into assertions about
// mutability rather than about the element. The variables are still non-fresh,
// so no excess-property check runs and the discriminant stays literal through
// the spread.
const steerCarryingRawStringIds = {
  ...steerBase,
  attachments: ["0f2b4d5e-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
};

const steerCarryingObjectAttachments = {
  ...steerBase,
  attachments: [{ kind: "blob" }],
};

const steerCarryingArtifactIds = {
  ...steerBase,
  attachments: ["0f2b4d5e-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as ArtifactId],
};

// @ts-expect-error — a raw `string` is not an `ArtifactId`: the id has to come
// from `ArtifactIdSchema` (or an explicit assertion at a boundary that knows).
export const steerWithRawIds: InterventionRequestPayload = steerCarryingRawStringIds;

// @ts-expect-error — the arm is no longer `unknown[]`; an object element is the
// exact shape the pre-discharge contract admitted.
export const steerWithObjects: InterventionRequestPayload = steerCarryingObjectAttachments;

// Positive control: branded ids assign off the same non-fresh shape, so the two
// refusals above are the element type and not a mismatch elsewhere.
export const steerWithArtifactIds: InterventionRequestPayload = steerCarryingArtifactIds;
