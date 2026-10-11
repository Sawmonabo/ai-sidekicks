// Type-level test of the `ArtifactId[]` files a send carries in `run/queue.ts`.

import type { ArtifactId } from "../artifacts/id.js";
import type { SessionId } from "../session/id.js";
import type { QueueItemCreateRequest } from "./queue.js";

// A producer composing the request in TypeScript never reaches the parser, so the type has to
// refuse an unbranded id itself. Widening the list to `unknown[]` makes both `@ts-expect-error`
// directives below report as unused.

const sendBase = {
  sessionId: "0f2b4d5e-1111-4111-8111-111111111111" as SessionId,
  clientIdempotencyKey: "0f2b4d5e-9999-4999-8999-999999999999",
  content: "see the attached trace",
} as const;

// Not `as const`: that would make `attachments` a readonly tuple, which never assigns to a
// mutable `ArtifactId[]`, so the refusals below would test mutability instead of the element.
const sendCarryingRawStringIds = {
  ...sendBase,
  attachments: ["0f2b4d5e-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
};

const sendCarryingObjectAttachments = {
  ...sendBase,
  attachments: [{ kind: "blob" }],
};

const sendCarryingArtifactIds = {
  ...sendBase,
  attachments: ["0f2b4d5e-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as ArtifactId],
};

// @ts-expect-error — a raw `string` is not an `ArtifactId`.
const _sendWithRawIds: QueueItemCreateRequest = sendCarryingRawStringIds;

// @ts-expect-error — the list is `ArtifactId[]`, so an object element is refused.
const _sendWithObjects: QueueItemCreateRequest = sendCarryingObjectAttachments;

// Positive control: branded ids assign off the same shape, so the refusals above are about the
// element type alone.
const _sendWithArtifactIds: QueueItemCreateRequest = sendCarryingArtifactIds;
