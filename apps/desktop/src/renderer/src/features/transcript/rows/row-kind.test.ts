// The one classifier table: which event types get a row kind, and how a tool result's state
// ranks.

import type { HydratedSessionEventContent } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import { classifyTranscriptRow, toolResultState } from "./row-kind.js";
import { sampleGeneralRow, sampleRunRow } from "@test/helpers/timeline-row-samples.js";

const AVAILABLE_BODY: HydratedSessionEventContent = { status: "available", body: "done" };
const TRUNCATED_BODY: HydratedSessionEventContent = {
  status: "available",
  body: "don",
  contentLength: 4096,
  contentTruncated: true,
};
const UNREADABLE_BODY: HydratedSessionEventContent = {
  status: "unavailable",
  reason: "decrypt_failed",
};

describe("the row kind classifier", () => {
  it("gives each body-bearing event type its own row kind", () => {
    const kindFor = (type: string): string | undefined =>
      classifyTranscriptRow(sampleRunRow({ type }))?.kind;
    expect(kindFor("user.message")).toBe("user-message");
    expect(kindFor("assistant.message")).toBe("agent-message");
    expect(kindFor("assistant.thinking_update")).toBe("thinking");
    expect(kindFor("tool.invoked")).toBe("tool-call");
    expect(kindFor("tool.result")).toBe("tool-call");
    expect(kindFor("tool.error")).toBe("tool-call");
  });

  it("gives every other event type no row kind", () => {
    expect(classifyTranscriptRow(sampleGeneralRow({ type: "session.created" }))).toBeUndefined();
    expect(classifyTranscriptRow(sampleRunRow({ type: "run.queued" }))).toBeUndefined();
  });
});

describe("the tool result state", () => {
  it("ranks a tool error above every body condition", () => {
    // A truncated error is still an error, and a collapsed row may not hide one.
    expect(toolResultState("tool.error", TRUNCATED_BODY)).toBe("error");
    expect(toolResultState("tool.error", UNREADABLE_BODY)).toBe("error");
    expect(toolResultState("tool.error", undefined)).toBe("error");
  });

  it("tells an unreadable body from a successful one", () => {
    expect(toolResultState("tool.result", UNREADABLE_BODY)).toBe("body-unavailable");
    expect(toolResultState("tool.result", AVAILABLE_BODY)).toBe("ok");
  });
});
