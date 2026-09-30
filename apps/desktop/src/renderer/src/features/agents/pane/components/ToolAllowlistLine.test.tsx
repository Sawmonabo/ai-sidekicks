// What each position says on the line, and that the line is on the card: a component nothing
// mounts is no control. The node-wide ceiling is held once per roster in
// `AgentBindingColumn.agent-list.test.tsx`.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TOOL_ALLOWLIST_NAMED_CAP } from "../../agents-caps.js";
import { formatCount } from "@renderer/lib/wire-figures.js";
import { agentEntry, resolvedConfiguration } from "./agent-binding-column.test-support.js";
import { AgentBindingCard } from "./AgentBindingCard.js";
import { ToolAllowlistLine } from "./ToolAllowlistLine.js";

function lineTextOf(container: HTMLElement): string {
  return container.querySelector(".meridian-agent-card__tool-allowlist")?.textContent ?? "";
}

/** A list of exactly `count` distinct tool names. */
function toolNames(count: number): readonly string[] {
  return Array.from({ length: count }, (_unused, index) => `tool-${String(index)}`);
}

describe("tool grant line — what each position says", () => {
  it("renders an unanswered grant as an absence rather than a set", () => {
    const { container } = render(<ToolAllowlistLine position={{ kind: "not-reported" }} />);
    expect(container.querySelector(".meridian-nothing--not-checked")).not.toBeNull();
    expect(lineTextOf(container)).toContain("Not reported");
    expect(lineTextOf(container)).not.toContain("default tool set");
  });

  it("says WHY nothing was answered in text, not in a tooltip", () => {
    // A `title` reaches no keyboard or screen-reader user, so the sentence is visible text.
    const { container } = render(<ToolAllowlistLine position={{ kind: "not-reported" }} />);
    expect(lineTextOf(container)).toContain("not started from a saved definition");
  });

  it("negative control: the sentence is read from the line's own text, not an attribute", () => {
    // Guards against the sentence moving back to `title`; `textContent` and `getAttribute` differ.
    const { container } = render(<ToolAllowlistLine position={{ kind: "not-reported" }} />);
    const badgeLabel = container.querySelector(".meridian-nothing__badge-label");
    expect(badgeLabel?.getAttribute("title")).toBeNull();
  });

  it("names the provider's default set as a muted absence, never as a restriction", () => {
    const { container } = render(<ToolAllowlistLine position={{ kind: "driver-default" }} />);
    expect(container.querySelector(".meridian-agent-card__axis-absent")).not.toBeNull();
    expect(lineTextOf(container)).toContain("default tool set");
  });

  it("renders an empty allowlist at full weight, because somebody chose it", () => {
    const { container } = render(<ToolAllowlistLine position={{ kind: "no-tools" }} />);
    expect(container.querySelector(".meridian-agent-card__axis-derived")).not.toBeNull();
    expect(lineTextOf(container)).toContain("No tools");
  });

  it("gives a populated allowlist its count and none of its names", () => {
    const { container } = render(
      <ToolAllowlistLine
        position={{ kind: "named", toolNames: ["read", "write", "search", "bash"] }}
      />,
    );
    expect(lineTextOf(container)).toContain("4 tools");
    expect(lineTextOf(container)).toContain("resolved configuration");
    expect(lineTextOf(container)).not.toContain("read");
  });

  it('names one tool as one tool, never as "1 tools"', () => {
    const { container } = render(
      <ToolAllowlistLine position={{ kind: "named", toolNames: ["read"] }} />,
    );
    expect(lineTextOf(container)).toContain("the one tool, named in the resolved");
    expect(lineTextOf(container)).not.toContain("1 tools");
  });

  it("promises only what the echo below it actually names", () => {
    // The disclosure names the first `TOOL_ALLOWLIST_NAMED_CAP` and folds the rest, so promising
    // all of a longer list would describe names that are not shown.
    const { container } = render(
      <ToolAllowlistLine position={{ kind: "named", toolNames: toolNames(15) }} />,
    );
    expect(lineTextOf(container)).toContain("15 tools");
    expect(lineTextOf(container)).toContain(
      `the first ${formatCount(TOOL_ALLOWLIST_NAMED_CAP)} are named`,
    );
  });

  it("negative control: at the cap it still promises the whole list", () => {
    // Guards against hedging every populated allowlist, including ones the echo names in full.
    const { container } = render(
      <ToolAllowlistLine
        position={{ kind: "named", toolNames: toolNames(TOOL_ALLOWLIST_NAMED_CAP) }}
      />,
    );
    expect(lineTextOf(container)).not.toContain("the first");
  });

  it("composes no verdict about whether this agent may browse", () => {
    // The line states the per-agent position and never a conjunction with the node-wide ceiling.
    const { container } = render(
      <ToolAllowlistLine position={{ kind: "named", toolNames: toolNames(4) }} />,
    );
    expect(lineTextOf(container)).not.toContain("allowed");
    expect(lineTextOf(container)).not.toContain("blocked");
  });

  it("states the per-agent position and leaves the node-wide ceiling to the roster", () => {
    // The ceiling note is said once by the roster, not per card.
    const { container } = render(<ToolAllowlistLine position={{ kind: "not-reported" }} />);
    expect(container.textContent ?? "").not.toContain("an allowlist cannot turn them back on");
  });
});

describe("tool grant line — it is on the card", () => {
  const ATTACHED_WITH_TOOLS = agentEntry({
    resolvedConfiguration: resolvedConfiguration({ toolAllowlist: ["read", "write"] }),
  });

  it("renders the grant for the agent the card was handed", () => {
    const { container } = render(<AgentBindingCard agent={ATTACHED_WITH_TOOLS} />);
    expect(lineTextOf(container)).toContain("2 tools");
  });

  it("negative control: an agent with no configuration draws the unanswered arm", () => {
    // Guards against a card that printed one position unconditionally.
    const { container } = render(<AgentBindingCard agent={agentEntry()} />);
    expect(lineTextOf(container)).toContain("Not reported");
    expect(lineTextOf(container)).not.toContain("tools");
  });
});
