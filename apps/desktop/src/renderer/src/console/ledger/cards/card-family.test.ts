// The classifier decides once — so these cases are about the ONE table.
//
// The failure this guards against is drift: a glyph table and a layout table that agree
// until somebody adds a family to one of them. Every case here reads the classifier's
// own answer rather than a per-field lookup, which is what makes the drift unrepresentable
// rather than merely unlikely.

import type { HydratedSessionEventContent } from "@ai-sidekicks/contracts";
import { describe, expect, it } from "vitest";

import {
  CARD_FAMILIES,
  CARD_LAYOUTS,
  TOOL_RESULT_STATES,
  cardFamilyDescriptor,
  classifyCardFamily,
  toolResultState,
} from "./card-family.js";
import { sampleGeneralRow, sampleRunRow } from "./row-samples.js";

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

describe("the card family classifier", () => {
  it("gives each body-bearing event type its own family", () => {
    const familyFor = (type: string): string => classifyCardFamily(sampleRunRow({ type })).family;
    expect(familyFor("user.message")).toBe("participant-message");
    expect(familyFor("assistant.message")).toBe("assistant-message");
    expect(familyFor("assistant.thinking_update")).toBe("assistant-reasoning");
    expect(familyFor("tool.invoked")).toBe("tool-activity");
    expect(familyFor("tool.result")).toBe("tool-activity");
    expect(familyFor("tool.error")).toBe("tool-activity");
  });

  it("files every other event type as a receipt", () => {
    expect(classifyCardFamily(sampleGeneralRow({ type: "session.created" })).family).toBe(
      "receipt",
    );
    expect(classifyCardFamily(sampleRunRow({ type: "run.queued" })).family).toBe("receipt");
  });

  it("negative control: a near-miss type is NOT absorbed by a prefix", () => {
    // Without this, a `startsWith("tool.")` implementation would pass every case above
    // and silently give an unreviewed future type the tool layout.
    expect(classifyCardFamily(sampleRunRow({ type: "tool.rehearsed" })).family).toBe("receipt");
    expect(classifyCardFamily(sampleRunRow({ type: "assistant.message.v2" })).family).toBe(
      "receipt",
    );
  });

  it("hands the icon, the label, and the layout out together", () => {
    for (const family of CARD_FAMILIES) {
      const descriptor = cardFamilyDescriptor(family);
      expect(descriptor.family).toBe(family);
      expect(descriptor.glyph.length).toBeGreaterThan(0);
      expect(descriptor.label.length).toBeGreaterThan(0);
      expect(CARD_LAYOUTS).toContain(descriptor.layout);
    }
  });

  it("opens message bodies and keeps tool rows and receipts to one line", () => {
    expect(cardFamilyDescriptor("participant-message").layout).toBe("body-open");
    expect(cardFamilyDescriptor("assistant-message").layout).toBe("body-open");
    expect(cardFamilyDescriptor("assistant-reasoning").layout).toBe("body-open");
    expect(cardFamilyDescriptor("tool-activity").layout).toBe("one-line");
    expect(cardFamilyDescriptor("receipt").layout).toBe("one-line");
  });

  it("classifies from the type alone — never from the tool's name", () => {
    // The wire declares no tool kind, so reading one out of the name would be the
    // console asserting a fact the daemon never sent.
    const bash = classifyCardFamily(
      sampleRunRow({ type: "tool.result", payload: { toolName: "Bash" } }),
    );
    const edit = classifyCardFamily(
      sampleRunRow({ type: "tool.result", payload: { toolName: "Edit" } }),
    );
    expect(bash).toStrictEqual(edit);
  });
});

describe("the tool result state", () => {
  it("ranks a tool error above every body condition", () => {
    // A truncated error is still an error: §5.9 forbids a collapsed row that hides one.
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
