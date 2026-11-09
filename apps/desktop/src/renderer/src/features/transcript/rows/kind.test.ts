// The one classifier table: which event types get no row kind, and how a tool result's state
// ranks.

import type { HydratedSessionEventContent } from "@ai-sidekicks/contracts/event/envelope";
import { describe, expect, it } from "vitest";

import { classifyTranscriptRow, toolResultState } from "./kind.js";
import { sampleGeneralRow, sampleRunRow } from "#test/helpers/transcript/event-row-samples.js";
import { projectedContentOf } from "#renderer/store/session/entities/projected-content.js";

const AVAILABLE_BODY = projectedContentOf({ status: "available", body: "done" });
const ABSENT_BODY: HydratedSessionEventContent = {
  status: "unavailable",
  reason: "absent",
};

describe("the row kind classifier", () => {
  it("gives every other event type no row kind", () => {
    expect(classifyTranscriptRow(sampleGeneralRow({ type: "session.created" }))).toBeUndefined();
    expect(classifyTranscriptRow(sampleRunRow({ type: "agent.run.queued" }))).toBeUndefined();
  });
});

describe("the tool result state", () => {
  it("ranks a tool error above every body condition", () => {
    // A collapsed row may not hide an error, whatever its body.
    expect(toolResultState("agent.toolCall.failed", AVAILABLE_BODY)).toBe("error");
    expect(toolResultState("agent.toolCall.failed", ABSENT_BODY)).toBe("error");
    expect(toolResultState("agent.toolCall.failed", undefined)).toBe("error");
  });

  it("tells an unreadable body from a successful one", () => {
    expect(toolResultState("agent.toolCall.completed", ABSENT_BODY)).toBe("body-unavailable");
    expect(toolResultState("agent.toolCall.completed", AVAILABLE_BODY)).toBe("ok");
  });
});
