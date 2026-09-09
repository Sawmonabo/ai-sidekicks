// What each position says, that the ceiling is said under every one of them, and
// that the line is actually on the card.
//
// The last case is the one that matters most: the per-agent control the governance
// rules name is only a control if a person meets it, and a component nothing mounts
// is exactly the state this line was built to leave.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { AgentRosterEntry } from "../../bridge/index.js";
import { AgentCard } from "./AgentCard.js";
import { ToolGrantLine } from "./ToolGrantLine.js";

/** The sentence every position sits under, so its absence is a red case anywhere. */
const CEILING_PHRASE = "an allowlist cannot turn them back on";

function lineTextOf(container: HTMLElement): string {
  return container.querySelector(".meridian-agent-card__tool-grant")?.textContent ?? "";
}

function noteTextOf(container: HTMLElement): string {
  return container.querySelector(".meridian-agent-card__grant-note")?.textContent ?? "";
}

describe("tool grant line — what each position says", () => {
  it("renders an unanswered grant as an absence rather than a set", () => {
    const { container } = render(<ToolGrantLine position={{ kind: "not-reported" }} />);
    expect(container.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
    expect(lineTextOf(container)).toContain("Not reported");
    expect(lineTextOf(container)).not.toContain("default tool set");
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
    const { container } = render(<ToolGrantLine position={{ kind: "named", toolCount: 4 }} />);
    expect(lineTextOf(container)).toContain("4 tools");
    expect(lineTextOf(container)).toContain("resolved configuration");
  });

  it('names one tool as one tool, never as "1 tools"', () => {
    const { container } = render(<ToolGrantLine position={{ kind: "named", toolCount: 1 }} />);
    expect(lineTextOf(container)).toContain("the one tool it was attached with");
    expect(lineTextOf(container)).not.toContain("1 tools");
  });

  it("says the node-wide ceiling under every position", () => {
    for (const position of [
      { kind: "not-reported" },
      { kind: "driver-default" },
      { kind: "no-tools" },
      { kind: "named", toolCount: 2 },
    ] as const) {
      const { container } = render(<ToolGrantLine position={position} />);
      expect(noteTextOf(container), position.kind).toContain(CEILING_PHRASE);
      expect(noteTextOf(container), position.kind).toContain("Applied at spawn");
    }
  });

  it("composes no verdict about whether this agent may browse", () => {
    // The console derives no eligibility the daemon owns: the line states the
    // per-agent position and the ceiling above it, and never their conjunction.
    const { container } = render(<ToolGrantLine position={{ kind: "named", toolCount: 4 }} />);
    const wholeLine = `${lineTextOf(container)} ${noteTextOf(container)}`;
    expect(wholeLine).not.toContain("allowed");
    expect(wholeLine).not.toContain("blocked");
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
    expect(container.textContent ?? "").toContain(CEILING_PHRASE);
  });

  it("negative control: an agent with no configuration draws the unanswered arm", () => {
    // Without this the case above would pass over a card that printed one position
    // unconditionally, which is the failure a governance line can least afford.
    const { container } = render(<AgentCard agent={{ agentId: "agent-scout", state: "ready" }} />);
    expect(lineTextOf(container)).toContain("Not reported");
    expect(lineTextOf(container)).not.toContain("tools");
  });
});
