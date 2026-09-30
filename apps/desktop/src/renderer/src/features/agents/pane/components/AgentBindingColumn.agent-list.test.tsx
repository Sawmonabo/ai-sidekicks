// What the column says about the roster as a whole. The node-wide tool-grant ceiling is stated
// once above the cards, not under each agent.

import { render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { settleReads } from "../agents-pane.test-support.js";
import {
  AGENT_ON_CLAUDE,
  AGENT_ON_CODEX,
  AgentListDaemon,
  bridgeCalling,
  disposeOpenedModels,
  modelsOver,
} from "./agent-binding-column.test-support.js";
import { AgentBindingColumn } from "./AgentBindingColumn.js";

afterEach(disposeOpenedModels);

/** The phrase the ceiling ends on, so a second copy of it is countable. */
const CEILING_PHRASE = "an allowlist cannot turn them back on";

function ceilingCountIn(container: HTMLElement): number {
  return (container.textContent ?? "").split(CEILING_PHRASE).length - 1;
}

async function columnOver(roster: readonly unknown[]): Promise<HTMLElement> {
  const scriptedDaemon = new AgentListDaemon(roster);
  const fixture = bridgeCalling(scriptedDaemon);
  const { container } = render(
    <AgentBindingColumn models={modelsOver(fixture, scriptedDaemon)} agentId={undefined} />,
  );
  await settleReads(fixture.scenarioEngine);
  return container;
}

describe("agent binding column — the node-wide tool-grant ceiling", () => {
  it("says it once above a roster of several agents", async () => {
    const container = await columnOver([AGENT_ON_CLAUDE, AGENT_ON_CODEX]);

    expect(container.querySelectorAll(".meridian-agent-card")).toHaveLength(2);
    expect(ceilingCountIn(container)).toBe(1);
  });

  it("still says it where the roster holds exactly one agent", async () => {
    // Guards against a column that stopped saying the ceiling for a single agent.
    const container = await columnOver([AGENT_ON_CLAUDE]);

    expect(container.querySelectorAll(".meridian-agent-card")).toHaveLength(1);
    expect(ceilingCountIn(container)).toBe(1);
  });

  it("states the mechanism rather than this agent's own grant", async () => {
    // The mechanism is the subject, which keeps it true under every position.
    const container = await columnOver([AGENT_ON_CLAUDE]);

    expect(container.textContent ?? "").toContain("A tool allowlist is applied at spawn");
  });

  it("negative control: an empty roster states no ceiling", async () => {
    // With no grant to qualify, a governance note would hang over an absence.
    const container = await columnOver([]);

    expect(container.querySelectorAll(".meridian-agent-card")).toHaveLength(0);
    expect(ceilingCountIn(container)).toBe(0);
  });
});
