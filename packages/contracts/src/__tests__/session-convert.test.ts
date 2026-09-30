// Converting a chat to a project: the request refuses an empty path, and the
// `session.converted` payload names the project the chat became.
import { describe, expect, it } from "vitest";

import { SessionConvertedPayloadSchema, SessionConvertRequestSchema } from "../session-convert.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const MOUNT_ID = "770e8400-e29b-41d4-a716-446655440002";
const IDEMPOTENCY_KEY = "0f2b4d5e-9999-4999-8999-999999999999";

describe("session.convert", () => {
  it("accepts a typed path and refuses an empty one", () => {
    expect(
      SessionConvertRequestSchema.safeParse({
        sessionId: SESSION_ID,
        path: "/Users/me/code/app",
        clientIdempotencyKey: IDEMPOTENCY_KEY,
      }).success,
    ).toBe(true);
    expect(
      SessionConvertRequestSchema.safeParse({
        sessionId: SESSION_ID,
        path: "",
        clientIdempotencyKey: IDEMPOTENCY_KEY,
      }).success,
    ).toBe(false);
  });

  it("records the project the chat became and the files it did not copy", () => {
    expect(
      SessionConvertedPayloadSchema.safeParse({
        sessionId: SESSION_ID,
        repoMountId: MOUNT_ID,
        copiedCount: 12,
        skippedPaths: ["README.md"],
      }).success,
    ).toBe(true);
    expect(
      SessionConvertedPayloadSchema.safeParse({
        sessionId: SESSION_ID,
        copiedCount: 12,
        skippedPaths: [],
      }).success,
    ).toBe(false);
  });
});
