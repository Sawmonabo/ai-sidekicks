// A session's birth record is the one place the lead, the shape, a fork's parent and a
// scratch session's definition are written, so the session is rebuilt from it alone. These
// cases hold that it carries a lead, that a fork names where it was taken, and that the
// open configuration records it once carried are refused.
import { describe, expect, it } from "vitest";

import { SessionCreatedPayloadSchema } from "../session-created.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const PARENT_SESSION_ID = "550e8400-e29b-41d4-a716-446655440009";
const USER_ID = "660e8400-e29b-41d4-a716-446655440001";
const AGENT_ID = "44444444-4444-4444-8444-444444444444";
const DEFINITION_ID = "11111111-1111-4111-8111-111111111111";

const FORKED_SCRATCH_SESSION = {
  sessionId: SESSION_ID,
  shape: "project",
  mainAgent: {
    agentId: AGENT_ID,
    name: "Implementer",
    binding: {
      driverName: "claude",
      modelId: "claude-sonnet-5",
      providerAccountId: null,
      effort: "high",
    },
    ancestry: [],
    createdAt: "2026-09-29T10:00:00Z",
  },
  parent: { sessionId: PARENT_SESSION_ID, anchorCursor: "cursor-41" },
  scratchForDefinitionId: DEFINITION_ID,
  actor: USER_ID,
} as const;

describe("session.created", () => {
  it("records the shape, the lead, a fork's parent and the definition a scratch session tries", () => {
    expect(SessionCreatedPayloadSchema.safeParse(FORKED_SCRATCH_SESSION).success).toBe(true);
  });

  it("refuses a session born without its lead", () => {
    const { mainAgent: _lead, ...leaderless } = FORKED_SCRATCH_SESSION;
    expect(SessionCreatedPayloadSchema.safeParse(leaderless).success).toBe(false);
  });

  it("refuses a fork that does not say which message it was taken at", () => {
    const fork = { ...FORKED_SCRATCH_SESSION, parent: { sessionId: PARENT_SESSION_ID } };
    expect(SessionCreatedPayloadSchema.safeParse(fork).success).toBe(false);
  });

  it("refuses the open configuration and metadata records", () => {
    const withConfig = { ...FORKED_SCRATCH_SESSION, config: {}, metadata: {} };
    expect(SessionCreatedPayloadSchema.safeParse(withConfig).success).toBe(false);
  });
});
