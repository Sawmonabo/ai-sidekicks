// An artifact event from a newer daemon still parses on an older reader, and a publish's base64
// payload is refused at the wire when it would hash bytes the caller never meant.
import { describe, expect, it } from "vitest";

import { SessionEventSchema } from "../../event/session.js";
import { buildSessionCreatedEvent } from "../../event/__tests__/session.test-support.js";
import { ArtifactPublishRequestSchema } from "../publication.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const ARTIFACT_ID = "0f2b4d5e-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("artifact.published", () => {
  it("parses an event whose payload carries a member it does not know and keeps that member", () => {
    const payload = {
      sessionId: SESSION_ID,
      artifactId: ARTIFACT_ID,
      state: "published",
      addedByNewerDaemon: { kept: true },
    };
    const event = {
      ...buildSessionCreatedEvent(),
      category: "artifact_publication",
      type: "artifact.published",
      payload,
    };
    expect(SessionEventSchema.parse(event).payload).toStrictEqual(payload);
  });
});

describe("ArtifactPublishRequestSchema", () => {
  it("refuses a base64 payload that is not base64, and reads the same text as utf8", () => {
    const request = {
      sessionId: SESSION_ID,
      artifactType: "summary",
      payload: "not base64!",
      mediaType: "text/plain",
    };
    expect(ArtifactPublishRequestSchema.safeParse(request).success).toBe(true);
    expect(
      ArtifactPublishRequestSchema.safeParse({ ...request, payloadEncoding: "base64" }).success,
    ).toBe(false);
    expect(
      ArtifactPublishRequestSchema.safeParse({
        ...request,
        payload: "aGVsbG8=",
        payloadEncoding: "base64",
      }).success,
    ).toBe(true);
  });
});
