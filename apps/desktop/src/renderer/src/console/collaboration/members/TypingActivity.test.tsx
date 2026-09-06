// The live line: what it says, and the one case where it says nothing at all.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ChannelActivity, ChannelActivityLabels } from "../activity-model.js";
import { TypingActivity } from "./TypingActivity.js";

const LABELS: ChannelActivityLabels = {
  participantLabel: (participantId) => participantId.replace("participant-", ""),
  runLabel: (runId) => runId.replace("run-", "agent "),
};

function composing(count: number): ChannelActivity {
  return {
    composing: Array.from({ length: count }, (_unused, index) => ({
      participantId: `participant-${String(index)}`,
      channelId: "channel-main",
      since: "2026-01-01T10:00:00.000Z",
    })),
    agentRuns: [],
  };
}

describe("the live line — nothing renders when nothing is live", () => {
  it("holds no space at all", () => {
    const { container } = render(
      <TypingActivity activity={{ composing: [], agentRuns: [] }} labels={LABELS} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("negative control: one composer does render a line", () => {
    const { container } = render(<TypingActivity activity={composing(1)} labels={LABELS} />);
    expect(container.querySelector(".meridian-activity")).not.toBeNull();
  });
});

describe("the live line — composing", () => {
  it("names one composer", () => {
    const { container } = render(<TypingActivity activity={composing(1)} labels={LABELS} />);
    expect(container.textContent ?? "").toBe("0 is composing");
  });

  it("names three", () => {
    const { container } = render(<TypingActivity activity={composing(3)} labels={LABELS} />);
    expect(container.textContent ?? "").toBe("0, 1 and 2 are composing");
  });

  it("folds to a count past the cap, because the names would churn", () => {
    const { container } = render(<TypingActivity activity={composing(4)} labels={LABELS} />);
    expect(container.textContent ?? "").toBe("4 people are composing");
  });

  it("negative control: the folded line names nobody", () => {
    const { container } = render(<TypingActivity activity={composing(4)} labels={LABELS} />);
    expect(container.textContent ?? "").not.toContain("0");
  });
});

describe("the live line — agent activity", () => {
  it("resolves a run to its agent, because the field carries no name", () => {
    const { container } = render(
      <TypingActivity
        activity={{
          composing: [],
          agentRuns: [
            { runId: "run-scout", channelId: "channel-main", since: "2026-01-01T10:00:00.000Z" },
          ],
        }}
        labels={LABELS}
      />,
    );
    expect(container.textContent ?? "").toBe("agent scout is working");
  });

  it("renders both halves when people and agents are working at once", () => {
    const { container } = render(
      <TypingActivity
        activity={{
          composing: composing(1).composing,
          agentRuns: [
            { runId: "run-scout", channelId: "channel-main", since: "2026-01-01T10:00:00.000Z" },
          ],
        }}
        labels={LABELS}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("is composing");
    expect(text).toContain("is working");
  });

  it("carries no content anywhere in what it renders", () => {
    // The indicator says who and where. There is no message text on the wire and
    // none on the screen; a surface that grew a preview would be transmitting one.
    const { container } = render(
      <TypingActivity
        activity={{
          composing: [
            {
              participantId: "participant-0",
              channelId: "channel-main",
              since: "2026-01-01T10:00:00.000Z",
            },
          ],
          agentRuns: [],
        }}
        labels={LABELS}
      />,
    );
    expect(container.textContent ?? "").toBe("0 is composing");
  });
});
