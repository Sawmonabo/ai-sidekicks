// Three absences on this card each MEAN something specific, so none of them may render
// as blank, as "off", or as the value beside it.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TOOL_ALLOWLIST_NAMED_CAP } from "../../agents-caps.js";
import { formatCount } from "@renderer/lib/wire-figures.js";
import { AgentBindingCard } from "./AgentBindingCard.js";
import { agentEntry, resolvedConfiguration } from "./agent-binding-column.test-support.js";

const RUNNING = agentEntry({
  binding: {
    driverName: "claude",
    modelId: "claude-sonnet",
    providerAccountId: null,
    effort: "high",
    outputSpeed: "fast",
  },
});

function observedTextOf(container: HTMLElement): string {
  return container.querySelector(".meridian-agent-card__observed")?.textContent ?? "";
}

/**
 * One row of the echo, addressed by its own term rather than by position.
 *
 * The `<dd>` carries no class of its own — every resolved row wears the same one — so
 * a positional query would silently become a different row the day an axis is added
 * above it.
 */
function resolvedRowTextOf(container: HTMLElement, term: string): string {
  const row = [...container.querySelectorAll(".meridian-agent-card__resolved-row")].find(
    (candidate) => candidate.querySelector("dt")?.textContent === term,
  );
  return row?.querySelector("dd")?.textContent ?? "";
}

function toolsRowTextOf(container: HTMLElement): string {
  return resolvedRowTextOf(container, "Tools");
}

function grantLineTextOf(container: HTMLElement): string {
  return container.querySelector(".meridian-agent-card__tool-allowlist")?.textContent ?? "";
}

describe("agent card — the effective binding", () => {
  it("names each axis the reply carried", () => {
    const { container } = render(<AgentBindingCard agent={RUNNING} />);
    const effective = container.querySelector(".meridian-agent-card__effective")?.textContent ?? "";
    expect(effective).toContain("claude-sonnet");
    expect(effective).toContain("high");
  });

  it("says what an unset axis MEANS rather than leaving it blank", () => {
    const { container } = render(<AgentBindingCard agent={agentEntry()} />);
    const effective = container.querySelector(".meridian-agent-card__effective")?.textContent ?? "";
    expect(effective).toContain("the provider's current account");
    expect(effective).toContain("the provider's default for this model");
    expect(effective).toContain("never set");
  });

  it("negative control: a carried axis does not print its absence sentence", () => {
    // Without this, the case above would pass over a card that printed every
    // absence meaning unconditionally.
    const { container } = render(<AgentBindingCard agent={RUNNING} />);
    const effective = container.querySelector(".meridian-agent-card__effective")?.textContent ?? "";
    expect(effective).not.toContain("the provider's default for this model");
  });
});

describe("agent card — the declared output speed is never the requested one", () => {
  it("reads NOT YET OBSERVED and names the three causes", () => {
    const { container } = render(<AgentBindingCard agent={RUNNING} />);
    expect(observedTextOf(container)).toContain("not yet observed");
    // The requested value is on the card, and must not be borrowed for this line.
    expect(observedTextOf(container)).not.toContain("fast");
  });

  it("negative control: a declared reading does appear on that same line", () => {
    // Without this, the case above would pass over a card whose observed line was a
    // fixed sentence that could never carry a provider reading at all.
    const { container } = render(
      <AgentBindingCard
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
      <AgentBindingCard
        agent={{
          ...RUNNING,
          resolvedConfiguration: resolvedConfiguration({ toolAllowlist: ["read", "write"] }),
        }}
      />,
    );
    const disclosure =
      container.querySelector(".meridian-agent-card__disclosure")?.textContent ?? "";
    expect(disclosure).toContain("definition-scout");
    expect(disclosure).toContain("sandboxed");
    expect(disclosure).toContain("Survey the repository");
  });

  it("says a posture, instructions and a goal nobody set rather than leaving them blank", () => {
    const { container } = render(
      <AgentBindingCard
        agent={{
          ...RUNNING,
          resolvedConfiguration: resolvedConfiguration({
            executionPostureMode: null,
            instructions: "",
            goal: null,
          }),
        }}
      />,
    );
    expect(resolvedRowTextOf(container, "Execution posture")).toBe("not pinned");
    expect(resolvedRowTextOf(container, "Instructions")).toBe("none");
    expect(resolvedRowTextOf(container, "Goal")).toBe("none");
  });

  it("negative control: an agent with no resolved configuration shows no echo", () => {
    const { container } = render(<AgentBindingCard agent={RUNNING} />);
    expect(container.querySelector(".meridian-agent-card__resolved")).toBeNull();
  });

  it("renders an empty allowlist as the restriction it is", () => {
    // "No tools at all" is the applied configuration and the strictest posture the
    // agent can have — a choice somebody made, not the daemon staying silent.
    const { container } = render(
      <AgentBindingCard
        agent={{ ...RUNNING, resolvedConfiguration: resolvedConfiguration({ toolAllowlist: [] }) }}
      />,
    );
    expect(toolsRowTextOf(container)).toContain("No tools");
    expect(toolsRowTextOf(container)).not.toContain("not reported");
  });

  it("negative control: an echo whose allowlist is null is not read as an empty one", () => {
    // Without this, the case above would pass over a card that reported an empty
    // allowlist for an axis the daemon never answered — the same conflation, in the
    // other direction.
    const { container } = render(
      <AgentBindingCard agent={{ ...RUNNING, resolvedConfiguration: resolvedConfiguration() }} />,
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
      <AgentBindingCard
        agent={{ ...RUNNING, resolvedConfiguration: resolvedConfiguration({ toolAllowlist }) }}
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
      <AgentBindingCard
        agent={{
          ...RUNNING,
          resolvedConfiguration: resolvedConfiguration({ toolAllowlist: ["read", "write"] }),
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
  it("gives an echo with a null allowlist the same reading in both places", () => {
    // The line read the grant projection and the Tools row read `toolAllowlist` for
    // itself, so one wire state was "the provider's default tool set" on the line and
    // "not reported" three lines below it — a card contradicting itself about the one
    // axis its whole tool-governance section exists to state.
    const { container } = render(
      <AgentBindingCard agent={{ ...RUNNING, resolvedConfiguration: resolvedConfiguration() }} />,
    );

    expect(grantLineTextOf(container)).toContain("default tool set");
    expect(toolsRowTextOf(container)).toContain("provider's default set");
    expect(grantLineTextOf(container)).not.toContain("reported");
    expect(toolsRowTextOf(container)).not.toContain("reported");
  });

  it("negative control: an agent with no resolved configuration does say so, on the line", () => {
    // Without this the case above would pass over a card that had stopped saying
    // "not reported" anywhere at all — which loses the fourth position outright and
    // is the same conflation the projection was built to refuse.
    const { container } = render(<AgentBindingCard agent={agentEntry()} />);

    expect(grantLineTextOf(container)).toContain("Not reported");
    expect(container.querySelector(".meridian-agent-card__resolved")).toBeNull();
  });

  it("says the empty-allowlist sentence once on the card, not once per renderer", () => {
    // Both renderers spelled the whole sentence, so the `no-tools` arm printed
    // "No tools." twice on one card. The line states the position; the disclosure adds
    // only what the line left out.
    const { container } = render(
      <AgentBindingCard
        agent={{ ...RUNNING, resolvedConfiguration: resolvedConfiguration({ toolAllowlist: [] }) }}
      />,
    );
    const wholeCard = container.textContent ?? "";

    expect(wholeCard.split("No tools.")).toHaveLength(2);
    expect(grantLineTextOf(container)).toContain("No tools.");
  });
});
