// The accessibility tier for the agent card, audited as a component. The agents feature's
// stylesheet is imported because contrast is measured on the rendered composition, so an
// unstyled card would report a palette nobody ships.
//
// The resolved-configuration echo is a `<dl>`, and axe's `definition-list` rule (`wcag2a`) is
// what catches a `<p>` or other foreign child among its groups, which assistive technology
// may fold or renumber.

import { describe, expect, it } from "vitest";

import { renderSettled } from "../helpers/app-harness.js";
import {
  PLANTED_VIOLATION_RULE_ID,
  describeViolations,
  plantAxeViolation,
  runTierAxe,
} from "./axe-run.js";

import "@renderer/features/agents/index.js";
import { installMeridianTokens } from "@renderer/app/token-installation.js";
import { AgentBindingCard } from "@renderer/features/agents/pane/components/AgentBindingCard.js";
import {
  agentEntry,
  resolvedConfiguration,
} from "@renderer/features/agents/pane/components/agent-binding-column.test-support.js";

/** An agent whose echo fills every row the card can draw, including the tail. */
const AGENT_WITH_FULL_ECHO = agentEntry({
  binding: {
    driverName: "claude",
    modelId: "claude-sonnet",
    providerAccountId: null,
    effort: "high",
    outputSpeed: "fast",
  },
  resolvedConfiguration: resolvedConfiguration({ toolAllowlist: ["read", "write", "search"] }),
});

/** The echo lives behind a disclosure, and a closed one renders no list to audit. */
function openEveryDisclosure(container: HTMLElement): void {
  for (const disclosure of container.querySelectorAll("details")) {
    disclosure.open = true;
  }
}

describe("accessibility — the agent card", () => {
  it("has no axe violation with a resolved configuration on screen", async () => {
    installMeridianTokens(document);
    const { container } = await renderSettled(<AgentBindingCard agent={AGENT_WITH_FULL_ECHO} />);
    openEveryDisclosure(container);

    expect(describeViolations(await runTierAxe(container))).toStrictEqual([]);
  });

  it("negative control: the tier's rule set does find a violation when there is one", async () => {
    // A misconfigured run (wrong root, wrong tags, a swallowed exception) returns the same
    // empty list the case above expects.
    const planted = plantAxeViolation();
    try {
      const violations = await runTierAxe(planted);
      expect(violations.map((violation) => violation.id)).toContain(PLANTED_VIOLATION_RULE_ID);
    } finally {
      planted.remove();
    }
  });
});
