// A link names two different sessions: the request refuses a session linked to itself before it
// reaches the daemon.
import { describe, expect, it } from "vitest";

import { SESSION_LINK_METHOD_DESCRIPTORS } from "../links.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const OTHER_SESSION_ID = "550e8400-e29b-41d4-a716-446655440001";

describe("session.linkAdd", () => {
  const { requestSchema } = SESSION_LINK_METHOD_DESCRIPTORS["session.linkAdd"];

  it("takes two different sessions and refuses a session linked to itself", () => {
    expect(
      requestSchema.safeParse({ sessionId: SESSION_ID, targetSessionId: OTHER_SESSION_ID }).success,
    ).toBe(true);
    expect(
      requestSchema.safeParse({ sessionId: SESSION_ID, targetSessionId: SESSION_ID }).success,
    ).toBe(false);
  });
});
