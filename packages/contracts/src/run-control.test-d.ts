// Type-level test of the `steer` arm's `ArtifactId[]` attachments in `run-control.ts`.

import type { ArtifactId, RunId } from "./provider-driver.js";
import type { InterventionRequestPayload } from "./run-control.js";

// A producer composing the payload in TypeScript never reaches the parser, so the type has to
// refuse an unbranded id itself. Widening the arm to `unknown[]` makes both `@ts-expect-error`
// directives below report as unused.

const steerBase = {
  type: "steer",
  targetRunId: "0f2b4d5e-6666-4666-8666-666666666666" as RunId,
  expectedRunVersion: 5,
  clientIdempotencyKey: "0f2b4d5e-9999-4999-8999-999999999999",
  content: "see the attached trace",
} as const;

// Not `as const`: that would make `attachments` a readonly tuple, which never assigns to a
// mutable `ArtifactId[]`, so the refusals below would test mutability instead of the element.
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

// @ts-expect-error — a raw `string` is not an `ArtifactId`.
export const steerWithRawIds: InterventionRequestPayload = steerCarryingRawStringIds;

// @ts-expect-error — the arm is `ArtifactId[]`, so an object element is refused.
export const steerWithObjects: InterventionRequestPayload = steerCarryingObjectAttachments;

// Positive control: branded ids assign off the same shape, so the refusals above are about the
// element type alone.
export const steerWithArtifactIds: InterventionRequestPayload = steerCarryingArtifactIds;
