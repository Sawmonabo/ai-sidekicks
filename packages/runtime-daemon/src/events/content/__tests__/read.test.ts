// `hydrateStoredEvent` pairs a stored event with its body: a row with no body reads as `absent`,
// never as an empty body; a text body echoes the stored length and truncation marker.

import { describe, expect, it } from "vitest";

import {
  CONTENT_LENGTH_PAYLOAD_KEY,
  CONTENT_TRUNCATED_PAYLOAD_KEY,
} from "@ai-sidekicks/contracts/event/declared-variants";
import { EventEnvelopeVersionSchema } from "@ai-sidekicks/contracts/event/envelope";
import { SessionIdSchema } from "@ai-sidekicks/contracts/session/id";
import type { EventEnvelope } from "@ai-sidekicks/contracts/event/envelope";

import { hydrateStoredEvent } from "../read.js";

const STORED_ENVELOPE: EventEnvelope = {
  id: "01960b3c-e1d0-7a41-b2c9-5f8e37d6a204",
  sessionId: SessionIdSchema.parse("0192f3a4-5b6c-7d8e-9f01-234567890abc"),
  sequence: 4,
  occurredAt: "2026-03-04T05:06:07.008Z",
  category: "event_maintenance",
  type: "event.compacted",
  actor: null,
  payload: { [CONTENT_LENGTH_PAYLOAD_KEY]: 120_000, [CONTENT_TRUNCATED_PAYLOAD_KEY]: true },
  version: EventEnvelopeVersionSchema.parse("1.0"),
};

describe("hydrateStoredEvent", () => {
  it("reads a NULL column as absent, never as an empty body", () => {
    expect(hydrateStoredEvent({ envelope: STORED_ENVELOPE, contentPayload: null })).toStrictEqual({
      event: STORED_ENVELOPE,
      content: { status: "unavailable", reason: "absent" },
    });
  });

  it("returns a text body with the stored length and truncation marker, not recomputed", () => {
    expect(
      hydrateStoredEvent({ envelope: STORED_ENVELOPE, contentPayload: "first part" }).content,
    ).toStrictEqual({
      status: "available",
      body: "first part",
      contentLength: 120_000,
      contentTruncated: true,
    });
  });
});
