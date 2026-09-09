// What the column says about the roster as a whole rather than about one agent.
//
// The node-wide tool-grant ceiling is the case here, and it is a case about a COUNT:
// the sentence was written under every card, so a session with four agents said the
// same three lines four times, and under a card whose reply carried no configuration
// it asserted that an allowlist had been applied at spawn. It is one statement about
// this node now, said once above the cards.

import { render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { settleReads } from "./agent-console.test-support.js";
import {
  AGENT_ON_CLAUDE,
  AGENT_ON_CODEX,
  HeldBindingMoveDaemon,
  bridgeCalling,
  disposeOpenedModels,
  modelsOver,
} from "./agent-binding-column.test-support.js";
import { AgentBindingColumn } from "./AgentBindingColumn.js";

afterEach(disposeOpenedModels);

/** The one phrase the ceiling ends on, so a second copy of it is countable. */
const CEILING_PHRASE = "an allowlist cannot turn them back on";

function ceilingCountIn(container: HTMLElement): number {
  return (container.textContent ?? "").split(CEILING_PHRASE).length - 1;
}

async function columnOver(roster: readonly unknown[]): Promise<HTMLElement> {
  const bridge = bridgeCalling(new HeldBindingMoveDaemon(roster));
  const { container } = render(
    <AgentBindingColumn models={modelsOver(bridge)} agentId={undefined} />,
  );
  await settleReads(bridge);
  return container;
}

describe("agent binding column — the node-wide tool-grant ceiling", () => {
  it("says it once above a roster of several agents", async () => {
    const container = await columnOver([AGENT_ON_CLAUDE, AGENT_ON_CODEX]);

    expect(container.querySelectorAll(".meridian-agent-card")).toHaveLength(2);
    expect(ceilingCountIn(container)).toBe(1);
  });

  it("still says it where the roster holds exactly one agent", async () => {
    // Without this the case above would be satisfied by a column that had stopped
    // saying the ceiling at all in the shape a reader most often meets.
    const container = await columnOver([AGENT_ON_CLAUDE]);

    expect(container.querySelectorAll(".meridian-agent-card")).toHaveLength(1);
    expect(ceilingCountIn(container)).toBe(1);
  });

  it("states the mechanism rather than this agent's own grant", async () => {
    // The subject is what makes it true under every position. "Applied at spawn",
    // with an agent as its implied subject, was a claim about a particular attach —
    // and under a reply that carried no configuration it was a claim about nothing.
    const container = await columnOver([AGENT_ON_CLAUDE]);

    expect(container.textContent ?? "").toContain("A tool allowlist is applied at spawn");
  });

  it("negative control: an empty roster states no ceiling", async () => {
    // There is no grant to qualify, so the sentence would be a governance note
    // hanging over an absence — and the empty state's own line is what a person came
    // for.
    const container = await columnOver([]);

    expect(container.querySelectorAll(".meridian-agent-card")).toHaveLength(0);
    expect(ceilingCountIn(container)).toBe(0);
  });
});
