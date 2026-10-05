// The availability arms, the tail, and the one control — each rendered as itself.

import type { ReasoningSurfaceReadResponse } from "@ai-sidekicks/contracts/transcript/operations";
import type { RunId } from "@ai-sidekicks/contracts/provider/driver/driver";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { type ReasoningReading } from "./reasoning-reading.js";
import { ThinkingRow } from "./ThinkingRow.js";

const SAMPLE_RUN_ID = "01J0000000000000000000000B" as RunId;

function renderThinkingRow(
  overrides: {
    readonly runId?: RunId | undefined;
    readonly liveText?: string;
    readonly reading?: ReasoningReading;
    readonly onExpand?: () => void;
  } = {},
): HTMLElement {
  const { container } = render(
    <ThinkingRow
      runId={"runId" in overrides ? overrides.runId : SAMPLE_RUN_ID}
      liveText={overrides.liveText}
      reading={overrides.reading ?? { status: "not-asked" }}
      onExpand={overrides.onExpand ?? (() => undefined)}
    />,
  );
  return container;
}

/** An `available` reply with entries and no continuation. */
function availableReply(bodies: readonly string[]): ReasoningSurfaceReadResponse {
  return {
    availability: "available",
    hasMore: false,
    reasoningEntries: bodies.map((content, index) => ({
      sequence: index,
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

describe("the expand control", () => {
  it("survives a refusal and says which press it is", () => {
    // A control drawn on `not-asked` alone would leave a briefly down transport's refusal on
    // screen with no way to ask again.
    const onExpand = vi.fn();
    const container = renderThinkingRow({
      onExpand,
      reading: {
        status: "refused",
        refusal: { code: "transcript.run_not_found", detail: "No such run.", origin: "daemon" },
      },
    });
    const control = container.querySelector<HTMLButtonElement>(
      ".meridian-reasoning-surface__expand",
    );
    expect(control?.textContent).toBe("Try the read again");
    control?.click();
    expect(onExpand).toHaveBeenCalledTimes(1);
  });
});

describe("the states around the read", () => {
  it("renders a refusal as the daemon's own sentence, never its code", () => {
    const container = renderThinkingRow({
      reading: {
        status: "refused",
        refusal: { code: "transcript.run_not_found", detail: "No such run.", origin: "daemon" },
      },
    });
    expect(container.textContent).toContain("No such run.");
    expect(container.textContent).not.toContain("transcript.run_not_found");
  });
});
