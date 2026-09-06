// The card keeps two lines apart, and each of these cases is one way of blurring them.
//
// The effective binding moves only when a terminal event lands; the pending line is
// a promise. And three absences on this card each MEAN something specific, so none
// of them may render as blank, as "off", or as the value beside it.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TOOL_ALLOWLIST_NAMED_CAP } from "../core/index.js";
import { formatCount } from "../primitives/index.js";
import { AgentCard } from "./AgentCard.js";
import { AgentRosterEmpty } from "./AgentRosterEmpty.js";
import type { AgentRosterEntry } from "../bridge/index.js";

const RUNNING: AgentRosterEntry = {
  agentId: "agent-scout",
  name: "Scout",
  state: "ready",
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

describe("agent card — the effective binding", () => {
  it("names each axis the reply carried", () => {
    const { container } = render(<AgentCard agent={RUNNING} />);
    const effective = container.querySelector(".meridian-agent-card__effective")?.textContent ?? "";
    expect(effective).toContain("claude-sonnet");
    expect(effective).toContain("high");
  });

  it("says what an absent axis MEANS rather than leaving it blank", () => {
    const { container } = render(
      <AgentCard agent={{ agentId: "agent-scout", state: "ready", driverName: "claude" }} />,
    );
    const effective = container.querySelector(".meridian-agent-card__effective")?.textContent ?? "";
    expect(effective).toContain("the provider's registered default");
    expect(effective).toContain("the driver's default for this model");
  });

  it("negative control: a carried axis does not print its absence sentence", () => {
    // Without this, the case above would pass over a card that printed every
    // absence meaning unconditionally.
    const { container } = render(<AgentCard agent={RUNNING} />);
    const effective = container.querySelector(".meridian-agent-card__effective")?.textContent ?? "";
    expect(effective).not.toContain("the driver's default for this model");
  });

  it("names the machine a `configured` agent is waiting on", () => {
    const { container } = render(
      <AgentCard agent={{ ...RUNNING, state: "configured", defaultNodeId: "node-2" }} />,
    );
    expect(container.textContent ?? "").toContain("waiting on its pinned machine to attach");
    expect(container.textContent ?? "").toContain("node-2");
  });

  it("renders a state it does not know as itself", () => {
    const { container } = render(<AgentCard agent={{ ...RUNNING, state: "quarantined" }} />);
    expect(container.textContent ?? "").toContain("quarantined");
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

describe("agent card — the pending line is separate from the effective one", () => {
  it("carries the promised axes, the boundary, and the displaced id", () => {
    const { container } = render(
      <AgentCard
        agent={{
          ...RUNNING,
          pendingSwitch: {
            switchId: "switch-8",
            appliesAt: "run_boundary",
            interruptRequested: false,
            pendingAxes: [{ axis: "driverName", value: "codex" }],
            replacedSwitchId: "switch-7",
          },
        }}
      />,
    );
    const pending = container.querySelector(".meridian-agent-card__pending")?.textContent ?? "";
    expect(pending).toContain("codex");
    expect(pending).toContain("at the next run boundary");
    expect(pending).toContain("switch-7");
    // The promise did not move the binding the agent runs under.
    const effective = container.querySelector(".meridian-agent-card__effective")?.textContent ?? "";
    expect(effective).toContain("claude");
    expect(effective).not.toContain("codex");
  });

  it("reads the interrupt from its own field, not from the boundary", () => {
    const interrupting = render(
      <AgentCard
        agent={{
          ...RUNNING,
          pendingSwitch: {
            switchId: "switch-9",
            appliesAt: "turn_boundary",
            interruptRequested: true,
            pendingAxes: [{ axis: "effort", value: "low" }],
          },
        }}
      />,
    );
    expect(
      interrupting.container.querySelector(".meridian-agent-card__pending")?.textContent ?? "",
    ).toContain("interrupting the run now");
  });

  it("negative control: the same boundary without the flag says nothing about an interrupt", () => {
    // A deferred and an interrupted switch both read `turn_boundary`, so a card
    // deriving one from the other would pass the case above and be wrong here.
    const { container } = render(
      <AgentCard
        agent={{
          ...RUNNING,
          pendingSwitch: {
            switchId: "switch-9",
            appliesAt: "turn_boundary",
            interruptRequested: false,
            pendingAxes: [{ axis: "effort", value: "low" }],
          },
        }}
      />,
    );
    expect(
      container.querySelector(".meridian-agent-card__pending")?.textContent ?? "",
    ).not.toContain("interrupting the run now");
  });

  it("carries no pending line at all where nothing is promised", () => {
    const { container } = render(<AgentCard agent={RUNNING} />);
    expect(container.querySelector(".meridian-agent-card__pending")).toBeNull();
  });
});

describe("agent card — the attach echo", () => {
  it("renders the snapshot and says it is one", () => {
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
    // The DISCLOSURE rather than the list: the note is prose about the echo and sits
    // beside the `<dl>`, whose content model admits only term/description groups.
    const disclosure =
      container.querySelector(".meridian-agent-card__disclosure")?.textContent ?? "";
    expect(disclosure).toContain("definition-scout");
    expect(disclosure).toContain("worktree");
    expect(disclosure).toContain("Survey the repository");
    expect(disclosure).toContain("snapshot taken when the agent was attached");
  });

  it("negative control: an agent attached inline shows no echo", () => {
    const { container } = render(<AgentCard agent={RUNNING} />);
    expect(container.querySelector(".meridian-agent-card__resolved")).toBeNull();
  });

  it("claims no definition for an echo that names none", () => {
    // An inline attach resolves a configuration and names no definition. Calling
    // that "attached from a definition" invented a row, and the note then promised
    // something about editing or deleting one that does not exist.
    const { container } = render(
      <AgentCard agent={{ ...RUNNING, resolvedConfiguration: FULLY_REPORTED }} />,
    );
    const disclosure =
      container.querySelector(".meridian-agent-card__disclosure")?.textContent ?? "";
    expect(disclosure).toContain("Resolved configuration");
    expect(disclosure).not.toContain("Attached from a definition");
    expect(disclosure).not.toContain("Editing or deleting the definition");
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
    expect(disclosure).toContain("Attached from a definition");
    expect(disclosure).toContain("definition-scout");
    expect(disclosure).toContain("Editing or deleting the definition");
  });

  it("renders an empty allowlist as the restriction it is", () => {
    // "No tools at all" is the applied configuration and the strictest posture the
    // agent can have — a choice somebody made, not the daemon staying silent.
    const { container } = render(
      <AgentCard
        agent={{ ...RUNNING, resolvedConfiguration: { ...FULLY_REPORTED, toolAllowlist: [] } }}
      />,
    );
    const resolved = container.querySelector(".meridian-agent-card__resolved")?.textContent ?? "";
    expect(resolved).toContain("No tools. This agent was attached with an empty allowlist.");
    expect(resolved).not.toContain("not reported");
  });

  it("negative control: an echo omitting the member still says nothing was reported", () => {
    // Without this, the case above would pass over a card that reported an empty
    // allowlist for an axis the daemon never answered — the same conflation, in the
    // other direction.
    const { container } = render(
      <AgentCard agent={{ ...RUNNING, resolvedConfiguration: FULLY_REPORTED }} />,
    );
    const resolved = container.querySelector(".meridian-agent-card__resolved")?.textContent ?? "";
    expect(resolved).toContain("not reported");
    expect(resolved).not.toContain("empty allowlist");
  });

  it("keeps the snapshot note out of the definition list's content model", () => {
    // A `<dl>` admits term/description pairs and the `<div>` groups that wrap them.
    // A `<p>` among them is content axe's `definition-list` rule flags and that a
    // screen reader may fold into the description above it — so the note would be
    // heard as part of the goal rather than as prose about the whole list.
    const { container } = render(
      <AgentCard
        agent={{
          ...RUNNING,
          resolvedFromDefinitionId: "definition-scout",
          resolvedConfiguration: { ...FULLY_REPORTED, toolAllowlist: ["read"] },
        }}
      />,
    );
    expect(container.querySelectorAll(".meridian-agent-card__resolved > p")).toHaveLength(0);
    expect(container.querySelectorAll(".meridian-agent-card__resolved > :not(div)")).toHaveLength(
      0,
    );
  });

  it("still renders the note, beside the list rather than inside it", () => {
    // Without this the assertion above would pass over a card that had dropped the
    // note entirely, which is the other way to satisfy an emptiness claim.
    const { container } = render(
      <AgentCard
        agent={{
          ...RUNNING,
          resolvedFromDefinitionId: "definition-scout",
          resolvedConfiguration: { ...FULLY_REPORTED, toolAllowlist: ["read"] },
        }}
      />,
    );
    const note = container.querySelector(".meridian-agent-card__snapshot-note");
    expect(note?.textContent ?? "").toContain("Editing or deleting the definition");
    expect(note?.parentElement?.className).not.toContain("meridian-agent-card__resolved");
  });

  it("negative control: the sweep bites on a paragraph planted in a definition list", () => {
    // The selectors above return nothing on a card that failed to render its echo at
    // all, so the checker is driven once against a tree whose verdict is known.
    const { container } = render(
      <dl className="meridian-agent-card__resolved">
        <div className="meridian-agent-card__resolved-row">
          <dt>Goal</dt>
          <dd>Survey the repository</dd>
        </div>
        <p>A note that does not belong here.</p>
      </dl>,
    );
    expect(container.querySelectorAll(".meridian-agent-card__resolved > p")).toHaveLength(1);
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

describe("agent card — actions are offered only where the caller supplied one", () => {
  it("draws each action it was handed", () => {
    const { container } = render(
      <AgentCard agent={RUNNING} onFollow={() => {}} onChangeBinding={() => {}} />,
    );
    expect(container.querySelectorAll(".meridian-agent-card__action").length).toBe(2);
  });

  it("negative control: a card handed none draws none", () => {
    const { container } = render(<AgentCard agent={RUNNING} />);
    expect(container.querySelectorAll(".meridian-agent-card__action").length).toBe(0);
  });
});

describe("agent roster — the empty state", () => {
  it("offers the one action there is", () => {
    const { container } = render(<AgentRosterEmpty onAttach={() => {}} />);
    expect(container.textContent ?? "").toContain("No agent is attached");
    expect(container.querySelector(".meridian-agent-card__action")).not.toBeNull();
  });

  it("negative control: with no handler it states the absence and offers nothing", () => {
    const { container } = render(<AgentRosterEmpty />);
    expect(container.textContent ?? "").toContain("No agent is attached");
    expect(container.querySelector(".meridian-agent-card__action")).toBeNull();
  });
});
