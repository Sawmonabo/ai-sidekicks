// The classifier decides once — so these cases are about the ONE table.
//
// The failure this guards against is drift: a glyph table and a layout table that agree
// until somebody adds a kind to one of them. Every case here reads the classifier's
// own answer rather than a per-field lookup, which is what makes the drift unrepresentable
// rather than merely unlikely.

import type { HydratedSessionEventContent } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import {
  TRANSCRIPT_ROW_KINDS,
  ROW_LAYOUTS,
  TOOL_RESULT_STATES,
  describeRowKind,
  classifyTranscriptRow,
  toolResultState,
} from "./row-kind.js";
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

  it("negative control: a near-miss type is NOT absorbed by a prefix", () => {
    // Without this, a `startsWith("tool.")` implementation would pass every case above
    // and silently give an unreviewed future type the tool layout.
    expect(classifyTranscriptRow(sampleRunRow({ type: "tool.rehearsed" }))).toBeUndefined();
    expect(classifyTranscriptRow(sampleRunRow({ type: "assistant.message.v2" }))).toBeUndefined();
  });

  it("hands the icon, the label, and the layout out together", () => {
    for (const kind of TRANSCRIPT_ROW_KINDS) {
      const descriptor = describeRowKind(kind);
      expect(descriptor.kind).toBe(kind);
      expect(descriptor.label.length).toBeGreaterThan(0);
      expect(ROW_LAYOUTS).toContain(descriptor.layout);
    }
  });

  it("opens message bodies and keeps tool rows to one line", () => {
    expect(describeRowKind("user-message").layout).toBe("body-open");
    expect(describeRowKind("agent-message").layout).toBe("body-open");
    expect(describeRowKind("thinking").layout).toBe("body-open");
    expect(describeRowKind("tool-call").layout).toBe("one-line");
  });

  it("classifies from the type alone — never from the tool's name", () => {
    // The wire declares no tool kind, so reading one out of the name would be the
    // console asserting a fact the daemon never sent.
    const bash = classifyTranscriptRow(
      sampleRunRow({ type: "tool.result", payload: { toolName: "Bash" } }),
    );
    const edit = classifyTranscriptRow(
      sampleRunRow({ type: "tool.result", payload: { toolName: "Edit" } }),
    );
    expect(bash).toStrictEqual(edit);
  });
});

describe("the tool result state", () => {
  it("ranks a tool error above every body condition", () => {
    // A truncated error is still an error, and a collapsed row may not hide one.
    expect(toolResultState("tool.error", TRUNCATED_BODY)).toBe("error");
    expect(toolResultState("tool.error", UNREADABLE_BODY)).toBe("error");
    expect(toolResultState("tool.error", undefined)).toBe("error");
  });

  it("reports a dispatched call as running", () => {
    expect(toolResultState("tool.invoked", undefined)).toBe("running");
  });

  it("tells an unreadable body from a successful one", () => {
    expect(toolResultState("tool.result", UNREADABLE_BODY)).toBe("body-unavailable");
    expect(toolResultState("tool.result", AVAILABLE_BODY)).toBe("ok");
  });

  it("reports a truncated body as truncated", () => {
    expect(toolResultState("tool.result", TRUNCATED_BODY)).toBe("truncated");
  });

  it("negative control: an unread body is not reported as unavailable", () => {
    // `undefined` means nobody asked for the body; `unavailable` means somebody asked
    // and it could not be read. Collapsing the two would put a failure on every
    // collapsed row in the log.
    expect(toolResultState("tool.result", undefined)).toBe("ok");
    expect(toolResultState("tool.result", undefined)).not.toBe("body-unavailable");
  });

  it("answers only inside its own closed set", () => {
    for (const eventType of ["tool.invoked", "tool.result", "tool.error"]) {
      expect(TOOL_RESULT_STATES).toContain(toolResultState(eventType, AVAILABLE_BODY));
    }
  });
});
