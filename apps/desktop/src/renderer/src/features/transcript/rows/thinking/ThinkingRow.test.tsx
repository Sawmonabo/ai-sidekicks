// The availability arms, the tail, and a refused read — each rendered as itself.

import type { TranscriptReasoningReadResponse } from "@ai-sidekicks/contracts/transcript/operations";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { publishedTextOf } from "#renderer/lib/text/published.js";
import { type ReasoningReading } from "./reasoning-reading.js";
import { ThinkingRow } from "./ThinkingRow.js";
import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { drawnText } from "#test/helpers/live-region.js";

const SAMPLE_RUN_ID = "01J0000000000000000000000B" as RunId;

function renderThinkingRow(
  overrides: {
    readonly runId?: RunId | undefined;
    readonly liveText?: string;
    readonly storedText?: string;
    readonly reading?: ReasoningReading;
    readonly onExpand?: () => void;
  } = {},
): HTMLElement {
  const { container } = render(
    <ThinkingRow
      runId={"runId" in overrides ? overrides.runId : SAMPLE_RUN_ID}
      liveText={overrides.liveText === undefined ? undefined : publishedTextOf(overrides.liveText)}
      storedText={
        overrides.storedText === undefined ? undefined : publishedTextOf(overrides.storedText)
      }
      reading={overrides.reading ?? { status: "not-asked" }}
      onExpand={overrides.onExpand ?? (() => undefined)}
    />,
    { wrapper: LiveAnnouncerProvider },
  );
  return container;
}

/** An `available` reply with entries and no continuation. */
function availableReply(bodies: readonly string[]): TranscriptReasoningReadResponse {
  return {
    availability: "available",
    hasMore: false,
    reasoningEntries: bodies.map((content, index) => ({
      sequence: index,
      rowId: "thinking-row",
      content,
      timestamp: "2026-09-02T10:00:00.000Z",
    })),
  };
}

describe("the availability arms", () => {
  it("renders the entries on the available arm", () => {
    const container = renderThinkingRow({
      reading: { status: "read", response: availableReply(["weighed the two branches"]) },
    });
    expect(container.textContent).toContain("weighed the two branches");
  });
});

describe("the streaming tail", () => {
  it("renders the tail beside a read rather than instead of it", () => {
    const container = renderThinkingRow({
      liveText: "still going",
      reading: { status: "read", response: availableReply(["settled entry"]) },
    });
    expect(container.textContent).toContain("still going");
    expect(container.textContent).toContain("settled entry");
  });
});

describe("the stored tail", () => {
  it("draws a read row's own entry at rest, and gives way once the whole reasoning is read", () => {
    const atRest = renderThinkingRow({ storedText: "weighed the two branches" });
    expect(atRest.textContent).toContain("weighed the two branches");

    const whole = renderThinkingRow({
      storedText: "kept tail",
      reading: { status: "read", response: availableReply(["the whole reasoning"]) },
    });
    expect(whole.textContent).not.toContain("kept tail");
    expect(whole.textContent).toContain("the whole reasoning");
  });
});

describe("a refused read", () => {
  it("says it couldn't load the reasoning, never the daemon's words, and asks again", () => {
    // A row with no way to ask again would leave a briefly down transport's refusal on screen.
    const onExpand = vi.fn();
    const container = renderThinkingRow({
      onExpand,
      reading: {
        status: "refused",
        refusal: { code: "agent.run.notFound", detail: "No such run.", origin: "daemon" },
      },
    });
    expect(drawnText(container)).toContain("Couldn't load reasoning");
    expect(drawnText(container)).not.toContain("No such run.");
    expect(drawnText(container)).not.toContain("agent.run.notFound");

    screen.getByRole("button", { name: "Try again" }).click();
    expect(onExpand).toHaveBeenCalledTimes(1);
  });
});
