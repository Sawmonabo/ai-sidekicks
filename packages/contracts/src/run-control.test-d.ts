// Conditional-type test against the `steer` arm's `ArtifactId[]` attachment
// element in `run-control.ts`, which the runtime suite cannot reach.

import type { ArtifactId, RunId } from "./provider-driver.js";
import type { InterventionRequestPayload } from "./run-control.js";

// The runtime suite proves the SCHEMA refuses a non-id element. That is a
// different claim: a producer composing the payload in TypeScript never reaches
// the parser, so an `unknown[]` arm would let a `string[]` of unvalidated ids —
// or an array of anything at all — assign cleanly. `ArtifactId` is a BRANDED
// string, so the assignments below make an unbranded id a compile-time error at
// the construction site rather than a runtime refusal at the far end of the wire.
//
// Widening the arm to `unknown[]` in `run-control.ts` makes both
// `@ts-expect-error` directives below report "Unused '@ts-expect-error'
// directive".

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

// @ts-expect-error — the arm is `ArtifactId[]`, so an object element is refused.
export const steerWithObjects: InterventionRequestPayload = steerCarryingObjectAttachments;

// Positive control: branded ids assign off the same non-fresh shape, so the two
// refusals above are the element type and not a mismatch elsewhere.
export const steerWithArtifactIds: InterventionRequestPayload = steerCarryingArtifactIds;
