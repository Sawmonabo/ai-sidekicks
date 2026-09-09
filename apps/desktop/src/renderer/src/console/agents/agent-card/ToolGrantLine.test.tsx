// What each position says on the line, and that the line is actually on the card.
//
// The last case is the one that matters most: the per-agent control the governance
// rules name is only a control if a person meets it, and a component nothing mounts
// is exactly the state this line was built to leave. The NODE-WIDE ceiling is no
// longer said here — `AgentBindingColumn.roster.test.tsx` holds it, once per roster.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TOOL_ALLOWLIST_NAMED_CAP } from "../../core/index.js";
import { formatCount } from "../../primitives/index.js";
import type { AgentRosterEntry } from "../../bridge/index.js";
import { AgentCard } from "./AgentCard.js";
import { ToolGrantLine } from "./ToolGrantLine.js";

function lineTextOf(container: HTMLElement): string {
  return container.querySelector(".meridian-agent-card__tool-grant")?.textContent ?? "";
}

/** A list of exactly `count` distinct tool names, which is all these cases need. */
function toolNames(count: number): readonly string[] {
  return Array.from({ length: count }, (_unused, index) => `tool-${String(index)}`);
}

describe("tool grant line — what each position says", () => {
  it("renders an unanswered grant as an absence rather than a set", () => {
    const { container } = render(<ToolGrantLine position={{ kind: "not-reported" }} />);
    expect(container.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
    expect(lineTextOf(container)).toContain("Not reported");
    expect(lineTextOf(container)).not.toContain("default tool set");
  });

  it("says WHY nothing was answered in text, not in a tooltip", () => {
    // The badge carried the whole explanation as `detail`, which the inline shape
    // renders as a `title` attribute — so the one position whose entire meaning is
    // "no question was put" explained itself to nobody using a keyboard or a screen
    // reader. The sentence is in the line now, and it has one home.
    const { container } = render(<ToolGrantLine position={{ kind: "not-reported" }} />);
    expect(lineTextOf(container)).toContain(
      "carried identity and lifecycle and no resolved configuration",
    );
  });

  it("negative control: the sentence is read from the line's own text, not an attribute", () => {
    // Without this the case above would pass over a badge that had put the sentence
    // back on `title`, since `textContent` and `getAttribute` are different reads and
    // only one of them is what a person hears.
    const { container } = render(<ToolGrantLine position={{ kind: "not-reported" }} />);
    const badgeLabel = container.querySelector(".meridian-nothing__badge-label");
    expect(badgeLabel?.getAttribute("title")).toBeNull();
  });

  it("names the driver's default set as a muted absence, never as a restriction", () => {
    const { container } = render(<ToolGrantLine position={{ kind: "driver-default" }} />);
    expect(container.querySelector(".meridian-agent-card__axis-absent")).not.toBeNull();
    expect(lineTextOf(container)).toContain("default tool set");
  });

  it("renders an empty allowlist at full weight, because somebody chose it", () => {
    const { container } = render(<ToolGrantLine position={{ kind: "no-tools" }} />);
    expect(container.querySelector(".meridian-agent-card__axis-derived")).not.toBeNull();
    expect(lineTextOf(container)).toContain("No tools");
  });

  it("gives a populated allowlist its count and none of its names", () => {
    const { container } = render(
      <ToolGrantLine
        position={{ kind: "named", toolNames: ["read", "write", "search", "bash"] }}
      />,
    );
    expect(lineTextOf(container)).toContain("4 tools");
    expect(lineTextOf(container)).toContain("resolved configuration");
    expect(lineTextOf(container)).not.toContain("read");
  });

  it('names one tool as one tool, never as "1 tools"', () => {
    const { container } = render(
      <ToolGrantLine position={{ kind: "named", toolNames: ["read"] }} />,
    );
    expect(lineTextOf(container)).toContain("the one tool it was attached with");
    expect(lineTextOf(container)).not.toContain("1 tools");
  });

  it("promises only what the echo below it actually names", () => {
    // The disclosure names the first `TOOL_ALLOWLIST_NAMED_CAP` and folds the rest to
    // a figure, so an agent attached with fifteen tools was promised all fifteen
    // below a list showing six.
    const { container } = render(
      <ToolGrantLine position={{ kind: "named", toolNames: toolNames(15) }} />,
    );
    expect(lineTextOf(container)).toContain("15 tools");
    expect(lineTextOf(container)).toContain(
      `the first ${formatCount(TOOL_ALLOWLIST_NAMED_CAP)} are named`,
    );
  });

  it("negative control: at the cap it still promises the whole list", () => {
    // Without this the case above would pass over a line that had started hedging
    // every populated allowlist, including the ones the echo does name in full.
    const { container } = render(
      <ToolGrantLine
        position={{ kind: "named", toolNames: toolNames(TOOL_ALLOWLIST_NAMED_CAP) }}
      />,
    );
    expect(lineTextOf(container)).not.toContain("the first");
  });

  it("composes no verdict about whether this agent may browse", () => {
    // The console derives no eligibility the daemon owns: the line states the
    // per-agent position and never a conjunction with the node-wide ceiling.
    const { container } = render(
      <ToolGrantLine position={{ kind: "named", toolNames: toolNames(4) }} />,
    );
    expect(lineTextOf(container)).not.toContain("allowed");
    expect(lineTextOf(container)).not.toContain("blocked");
  });

  it("states the per-agent position and leaves the node-wide ceiling to the roster", () => {
    // Under the unanswered position the ceiling note asserted that an allowlist had
    // been applied at spawn — a claim about a reply that named none — and it said so
    // again under every other card in the roster.
    const { container } = render(<ToolGrantLine position={{ kind: "not-reported" }} />);
    expect(container.textContent ?? "").not.toContain("an allowlist cannot turn them back on");
  });
});

describe("tool grant line — it is on the card", () => {
  const ATTACHED_WITH_TOOLS: AgentRosterEntry = {
    agentId: "agent-scout",
    name: "Scout",
    state: "ready",
    driverName: "claude",
    resolvedConfiguration: { toolAllowlist: ["read", "write"] },
  };

  it("renders the grant for the agent the card was handed", () => {
    const { container } = render(<AgentCard agent={ATTACHED_WITH_TOOLS} />);
    expect(lineTextOf(container)).toContain("2 tools");
  });

  it("negative control: an agent with no configuration draws the unanswered arm", () => {
    // Without this the case above would pass over a card that printed one position
    // unconditionally, which is the failure a governance line can least afford.
    const { container } = render(<AgentCard agent={{ agentId: "agent-scout", state: "ready" }} />);
    expect(lineTextOf(container)).toContain("Not reported");
    expect(lineTextOf(container)).not.toContain("tools");
  });
});
