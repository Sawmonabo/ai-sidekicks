// Three absences on this card each MEAN something specific, so none of them may render
// as blank, as "off", or as the value beside it.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TOOL_ALLOWLIST_NAMED_CAP } from "../../core/index.js";
import { formatCount } from "../../primitives/index.js";
import { AgentCard } from "./AgentCard.js";
import type { AgentRosterEntry } from "../../bridge/index.js";

const RUNNING: AgentRosterEntry = {
  agentId: "agent-scout",
  name: "Scout",
  driverName: "claude",
  modelId: "claude-sonnet",
  config: { effort: "high", outputSpeed: "fast" },
};

/** Every echo axis but the allowlist, so "not reported" can only be about tools. */
const FULLY_REPORTED = {
  executionPostureMode: "worktree",
  instructions: "Read before writing.",
  goal: "Survey the repository",
} as const;

function observedTextOf(container: HTMLElement): string {
  return container.querySelector(".meridian-agent-card__observed")?.textContent ?? "";
}

/**
 * The echo's Tools row, addressed by its own term rather than by position.
 *
 * The `<dd>` carries no class of its own — every resolved row wears the same one — so
 * a positional query would silently become a different row the day an axis is added
 * above it.
 */
function toolsRowTextOf(container: HTMLElement): string {
  const toolsRow = [...container.querySelectorAll(".meridian-agent-card__resolved-row")].find(
    (row) => row.querySelector("dt")?.textContent === "Tools",
  );
  return toolsRow?.querySelector("dd")?.textContent ?? "";
}

function grantLineTextOf(container: HTMLElement): string {
  return container.querySelector(".meridian-agent-card__tool-grant")?.textContent ?? "";
}

describe("agent card — the effective binding", () => {
  it("names each axis the reply carried", () => {
    const { container } = render(<AgentCard agent={RUNNING} />);
    const effective = container.querySelector(".meridian-agent-card__effective")?.textContent ?? "";
    expect(effective).toContain("claude-sonnet");
    expect(effective).toContain("high");
  });

  it("says what an absent axis MEANS rather than leaving it blank", () => {
    const { container } = render(
      <AgentCard agent={{ agentId: "agent-scout", driverName: "claude" }} />,
    );
    const effective = container.querySelector(".meridian-agent-card__effective")?.textContent ?? "";
    expect(effective).toContain("the provider's registered default");
    expect(effective).toContain("the provider's default for this model");
  });

  it("negative control: a carried axis does not print its absence sentence", () => {
    // Without this, the case above would pass over a card that printed every
    // absence meaning unconditionally.
    const { container } = render(<AgentCard agent={RUNNING} />);
    const effective = container.querySelector(".meridian-agent-card__effective")?.textContent ?? "";
    expect(effective).not.toContain("the provider's default for this model");
  });
});

describe("agent card — the declared output speed is never the requested one", () => {
  it("reads NOT YET OBSERVED and names the three causes", () => {
    const { container } = render(<AgentCard agent={RUNNING} />);
    expect(observedTextOf(container)).toContain("not yet observed");
    // The requested value is on the card, and must not be borrowed for this line.
    expect(observedTextOf(container)).not.toContain("fast");
  });

  it("negative control: a declared reading does appear on that same line", () => {
    // Without this, the case above would pass over a card whose observed line was a
    // fixed sentence that could never carry a provider reading at all.
    const { container } = render(
      <AgentCard
        agent={{
          ...RUNNING,
          observedOutputSpeed: { declared: "standard", reason: "account tier" },
        }}
      />,
    );
    expect(observedTextOf(container)).toContain("standard");
    expect(observedTextOf(container)).toContain("account tier");
    expect(observedTextOf(container)).not.toContain("not yet observed");
  });
});

describe("agent card — the resolved configuration", () => {
  it("renders the snapshot", () => {
    const { container } = render(
      <AgentCard
        agent={{
          ...RUNNING,
          resolvedFromDefinitionId: "definition-scout",
          resolvedConfiguration: {
            executionPostureMode: "worktree",
            toolAllowlist: ["read", "write"],
            goal: "Survey the repository",
          },
        }}
      />,
    );
    const disclosure =
      container.querySelector(".meridian-agent-card__disclosure")?.textContent ?? "";
    expect(disclosure).toContain("definition-scout");
    expect(disclosure).toContain("worktree");
    expect(disclosure).toContain("Survey the repository");
  });

  it("negative control: an agent with no resolved configuration shows no echo", () => {
    const { container } = render(<AgentCard agent={RUNNING} />);
    expect(container.querySelector(".meridian-agent-card__resolved")).toBeNull();
  });

  it("claims no definition for an echo that names none", () => {
    // A configuration resolved inline names no definition. A Definition row would
    // invent one.
    const { container } = render(
      <AgentCard agent={{ ...RUNNING, resolvedConfiguration: FULLY_REPORTED }} />,
    );
    const disclosure =
      container.querySelector(".meridian-agent-card__disclosure")?.textContent ?? "";
    expect(disclosure).toContain("Resolved configuration");
    expect(disclosure).not.toContain("Definition");
  });

  it("negative control: an echo that DOES name one is attributed to it", () => {
    // Without this the case above would pass over a card that had stopped naming a
    // definition at all, which loses the one thing the disclosure exists to say.
    const { container } = render(
      <AgentCard
        agent={{
          ...RUNNING,
          resolvedFromDefinitionId: "definition-scout",
          resolvedConfiguration: FULLY_REPORTED,
        }}
      />,
    );
    const disclosure =
      container.querySelector(".meridian-agent-card__disclosure")?.textContent ?? "";
    expect(disclosure).toContain("Definition");
    expect(disclosure).toContain("definition-scout");
  });

  it("renders an empty allowlist as the restriction it is", () => {
    // "No tools at all" is the applied configuration and the strictest posture the
    // agent can have — a choice somebody made, not the daemon staying silent.
    const { container } = render(
      <AgentCard
        agent={{ ...RUNNING, resolvedConfiguration: { ...FULLY_REPORTED, toolAllowlist: [] } }}
      />,
    );
    expect(toolsRowTextOf(container)).toContain("No tools");
    expect(toolsRowTextOf(container)).not.toContain("not reported");
  });

  it("negative control: an echo omitting the member is not read as an empty one", () => {
    // Without this, the case above would pass over a card that reported an empty
    // allowlist for an axis the daemon never answered — the same conflation, in the
    // other direction.
    const { container } = render(
      <AgentCard agent={{ ...RUNNING, resolvedConfiguration: FULLY_REPORTED }} />,
    );
    expect(toolsRowTextOf(container)).not.toContain("empty allowlist");
    expect(toolsRowTextOf(container)).not.toContain("No tools");
  });

  it("counts the unnamed tail through the console's own figure formatter", () => {
    // The allowlist is the daemon's, so its length is unbounded by anything this
    // console decides. Four figures is where the two spellings part company: a
    // stringified tail reads "1200" beside every other quantity in the console
    // reading "1,200", which is a second formatting path in the one place the
    // chokepoint exists to keep single.
    const unnamedToolCount = 1200;
    const toolAllowlist = Array.from(
      { length: TOOL_ALLOWLIST_NAMED_CAP + unnamedToolCount },
      (_unused, index) => `tool-${String(index)}`,
    );
    const { container } = render(
      <AgentCard
        agent={{ ...RUNNING, resolvedConfiguration: { ...FULLY_REPORTED, toolAllowlist } }}
      />,
    );
    const resolved = container.querySelector(".meridian-agent-card__resolved")?.textContent ?? "";
    expect(resolved).toContain(` and ${formatCount(unnamedToolCount)} more`);
  });

  it("negative control: the two spellings of that tail are different strings", () => {
    // Without this the case above would pass over a host whose locale groups
    // nothing, and would prove nothing about which formatter the tail reaches for.
    expect(formatCount(1200, "en-US")).not.toBe(String(1200));
  });

  it("negative control: a populated allowlist still names its tools", () => {
    const { container } = render(
      <AgentCard
        agent={{
          ...RUNNING,
          resolvedConfiguration: { ...FULLY_REPORTED, toolAllowlist: ["read", "write"] },
        }}
      />,
    );
    const resolved = container.querySelector(".meridian-agent-card__resolved")?.textContent ?? "";
    expect(resolved).toContain("read");
    expect(resolved).not.toContain("empty allowlist");
    expect(resolved).not.toContain("not reported");
  });
});

describe("agent card — one wire state, one reading of it", () => {
  it("gives an echo with no allowlist member the same reading in both places", () => {
    // The line read the grant projection and the Tools row read `toolAllowlist` for
    // itself, so one wire state was "the provider's default tool set" on the line and
    // "not reported" three lines below it — a card contradicting itself about the one
    // axis its whole tool-governance section exists to state.
    const { container } = render(
      <AgentCard agent={{ ...RUNNING, resolvedConfiguration: FULLY_REPORTED }} />,
    );

    expect(grantLineTextOf(container)).toContain("default tool set");
    expect(toolsRowTextOf(container)).toContain("provider's default set");
    expect(grantLineTextOf(container)).not.toContain("reported");
    expect(toolsRowTextOf(container)).not.toContain("reported");
  });

  it("negative control: a reply that reported NOTHING does say so, on the line", () => {
    // Without this the case above would pass over a card that had stopped saying
    // "not reported" anywhere at all — which loses the fourth position outright and
    // is the same conflation the projection was built to refuse.
    const { container } = render(<AgentCard agent={{ agentId: "agent-scout" }} />);

    expect(grantLineTextOf(container)).toContain("Not reported");
    expect(container.querySelector(".meridian-agent-card__resolved")).toBeNull();
  });

  it("says the empty-allowlist sentence once on the card, not once per surface", () => {
    // Both renderers spelled the whole sentence, so the `no-tools` arm printed
    // "No tools." twice on one card. The line states the position; the disclosure adds
    // only what the line left out.
    const { container } = render(
      <AgentCard
        agent={{ ...RUNNING, resolvedConfiguration: { ...FULLY_REPORTED, toolAllowlist: [] } }}
      />,
    );
    const wholeCard = container.textContent ?? "";

    expect(wholeCard.split("No tools.")).toHaveLength(2);
    expect(grantLineTextOf(container)).toContain("No tools.");
  });
});
