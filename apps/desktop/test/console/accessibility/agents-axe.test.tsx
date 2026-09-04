// The accessibility tier for the agents family.
//
// The card is audited as a component rather than through a destination, because the
// host that mounts an agent roster has not landed — the same position the three
// sidebar surfaces in this tier's collaboration file are in, and the family's
// stylesheet is imported for the same reason: contrast is measured on the rendered
// composition rather than on the token table, so a card audited unstyled would
// report a palette nobody ships.
//
// ONE STRUCTURAL RULE IS THE POINT OF THIS FILE. The resolved-configuration echo is
// a `<dl>`, and axe's `definition-list` rule carries `wcag2a`, which is already in
// this tier's tag set — so the audit below is what catches a `<p>` or any other
// foreign child appearing among its groups. A list whose content model is broken is
// one assistive technology may fold or renumber, and the note that used to sit there
// would have been heard as part of the goal above it.

import { describe, expect, it } from "vitest";

import { renderSettled } from "../console-harness.js";
import { axeViolationsIn, plantedViolationIds } from "./axe-run.js";

import "../../../src/renderer/src/console/agents/index.js";
import { installMeridianTokens } from "../../../src/renderer/src/console/frame/index.js";
import { AgentCard } from "../../../src/renderer/src/console/agents/AgentCard.js";
import type { AgentRosterEntry } from "../../../src/renderer/src/console/agents/agent-wire.js";

/** An agent whose echo fills every row the card can draw, including the tail. */
const AGENT_WITH_FULL_ECHO: AgentRosterEntry = {
  agentId: "agent-scout",
  name: "Scout",
  state: "ready",
  driverName: "claude",
  modelId: "claude-sonnet",
  config: { effort: "high", outputSpeed: "fast" },
  resolvedFromDefinitionId: "definition-scout",
  resolvedConfiguration: {
    executionPostureMode: "worktree",
    toolAllowlist: ["read", "write", "search"],
    instructions: "Read before writing.",
    goal: "Survey the repository",
  },
};

/** The echo lives behind a disclosure, and a closed one renders no list to audit. */
function openEveryDisclosure(container: HTMLElement): void {
  for (const disclosure of container.querySelectorAll("details")) {
    disclosure.open = true;
  }
}

describe("accessibility — the agent card", () => {
  it("has no axe violation with a resolved configuration on screen", async () => {
    installMeridianTokens(document);
    const { container } = await renderSettled(<AgentCard agent={AGENT_WITH_FULL_ECHO} />);
    openEveryDisclosure(container);

    expect(await axeViolationsIn(container)).toStrictEqual([]);
  });

  it("negative control: the tier's rule set does find a violation when there is one", async () => {
    // axe returning nothing is the expected result above, and a misconfigured run —
    // wrong root, wrong tags, an exception swallowed — returns exactly the same
    // nothing.
    expect(await plantedViolationIds()).not.toStrictEqual([]);
  });
});
