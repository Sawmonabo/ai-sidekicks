// The live line: what it says, and the one case where it says nothing at all.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ChannelActivity, ChannelActivityLabels } from "./activity-model.js";
import { AgentActivityLine } from "./AgentActivityLine.js";

const LABELS: ChannelActivityLabels = {
  runLabel: (runId) => runId.replace("run-", "agent "),
};

function working(count: number): ChannelActivity {
  return {
    agentRuns: Array.from({ length: count }, (_unused, index) => ({
      runId: `run-${String(index)}`,
      channelId: "channel-main",
      since: "2026-01-01T10:00:00.000Z",
    })),
  };
}

describe("the live line — nothing renders when nothing is live", () => {
  it("holds no space at all", () => {
    const { container } = render(
      <AgentActivityLine activity={{ agentRuns: [] }} labels={LABELS} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("negative control: one working run does render a line", () => {
    const { container } = render(<AgentActivityLine activity={working(1)} labels={LABELS} />);
    expect(container.querySelector(".meridian-activity")).not.toBeNull();
  });
});

describe("the live line — agent activity", () => {
  it("resolves a run to its agent, because the field carries no name", () => {
    const { container } = render(
      <AgentActivityLine
        activity={{
          agentRuns: [
            { runId: "run-scout", channelId: "channel-main", since: "2026-01-01T10:00:00.000Z" },
          ],
        }}
        labels={LABELS}
      />,
    );
    expect(container.textContent ?? "").toBe("agent scout is working");
  });

  it("names three", () => {
    const { container } = render(<AgentActivityLine activity={working(3)} labels={LABELS} />);
    expect(container.textContent ?? "").toBe("agent 0, agent 1, agent 2 are working");
  });

  it("folds to a count past the cap, because the names would churn", () => {
    const { container } = render(<AgentActivityLine activity={working(4)} labels={LABELS} />);
    expect(container.textContent ?? "").toBe("4 runs are working");
  });

  it("negative control: the folded line names nobody", () => {
    const { container } = render(<AgentActivityLine activity={working(4)} labels={LABELS} />);
    expect(container.textContent ?? "").not.toContain("agent 0");
  });

  it("carries no content anywhere in what it renders", () => {
    // The indicator says which run and where. There is no message text on the wire and
    // none on the screen; a surface that grew a preview would be transmitting one.
    const { container } = render(<AgentActivityLine activity={working(1)} labels={LABELS} />);
    expect(container.textContent ?? "").toBe("agent 0 is working");
  });
});
