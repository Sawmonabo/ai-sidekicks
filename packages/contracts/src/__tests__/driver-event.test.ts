// `driver.subscribeEvents` streams one run's driver activity, and the client validates each frame
// against `DriverEventSchema`, which must refuse every other session event.

import { describe, expect, it } from "vitest";

import { DriverEventSchema } from "../driver-event.js";
import { SessionEventSchema } from "../event.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const USER_ID = "660e8400-e29b-41d4-a716-446655440001";
const RUN_ID = "990e8400-e29b-41d4-a716-446655440004";
const VERSION = "1.0";

// One driver-category fixture and one non-driver one: the minimum that separates "refuses
// non-driver events" from "refuses everything".
const buildAssistantMessage = () => ({
  id: "evt-3601",
  sessionId: SESSION_ID,
  sequence: 40,
  occurredAt: "2026-01-22T19:15:01.000Z",
  category: "assistant_output" as const,
  type: "assistant.message" as const,
  actor: null,
  version: VERSION,
  payload: {
    sessionId: SESSION_ID,
    runId: RUN_ID,
    contentType: "text/markdown",
    contentLength: 4096,
  },
});

const buildSessionCreated = () => ({
  id: "evt-0001",
  sessionId: SESSION_ID,
  sequence: 0,
  occurredAt: "2026-01-22T19:14:35.000Z",
  category: "session_lifecycle" as const,
  type: "session.created" as const,
  actor: USER_ID,
  version: VERSION,
  payload: {
    sessionId: SESSION_ID,
    shape: "chat",
    mainAgent: {
      agentId: "44444444-4444-4444-8444-444444444444",
      name: "Implementer",
      binding: {
        driverName: "claude",
        modelId: "claude-sonnet-5",
        providerAccountId: null,
        effort: null,
      },
      ancestry: [],
      createdAt: "2026-01-22T19:14:35.000Z",
    },
  },
});

describe("DriverEvent", () => {
  it("DriverEventSchema accepts a driver event", () => {
    const parsed = DriverEventSchema.safeParse(buildAssistantMessage());
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual(buildAssistantMessage());
  });

  it("DriverEventSchema REFUSES a schema-valid non-driver session event", () => {
    const nonDriver = buildSessionCreated();
    // Premise: without it the refusal below could be any parse failure.
    expect(SessionEventSchema.safeParse(nonDriver).success).toBe(true);

    const parsed = DriverEventSchema.safeParse(nonDriver);
    expect(parsed.success).toBe(false);
    expect(parsed.success === false && parsed.error.issues).toEqual([
      expect.objectContaining({ path: ["type"] }),
    ]);
  });
});
