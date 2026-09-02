// The agent console says which agent it is about, or says it does not know.
//
// One body mounted twice — by the deck as a pane and by the frame as an auxiliary
// window — so the cases drive the COMPONENT rather than either mount, and the two
// registrars are covered where they are composed. What is checked here is the pair
// of absences a mount cannot rule out: an address that named a session and no
// agent, and a definition editor whose body belongs to another plan.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AgentConsolePane } from "./AgentConsolePane.js";

describe("agent console — the agent it is about", () => {
  it("renders the agent id as a wire figure, verbatim", () => {
    // A wire string wears the provenance signature. Rendered as prose it would be
    // indistinguishable from a name the console composed.
    const { container } = render(
      <AgentConsolePane sessionId="session-9" agentId="agent-scout" bridgeSource="fixture" />,
    );
    const figure = container.querySelector(".meridian-figure--wire");
    expect(figure?.textContent).toBe("agent-scout");
  });

  it("says so when the address named a session and no agent", () => {
    // Reachable: the frame's context picker resolves a bare auxiliary address by
    // choosing a session, and the agent-console grammar carries its agent with its
    // session — so a picked session arrives here with no agent named.
    const { container } = render(
      <AgentConsolePane sessionId="session-9" agentId={undefined} bridgeSource="fixture" />,
    );
    expect(container.textContent ?? "").toContain("not yet on one of its agents");
  });

  it("negative control: the subject line is not the same in both cases", () => {
    // Without this, the two cases above would pass over a pane that rendered one
    // fixed sentence and never the id.
    const { container } = render(
      <AgentConsolePane sessionId="session-9" agentId="agent-scout" bridgeSource="fixture" />,
    );
    expect(container.textContent ?? "").not.toContain("not yet on one of its agents");
  });
});

describe("agent console — the machines column", () => {
  it("says the question was not put under the fixture", () => {
    // The node roster reads the installed bridge directly, so under the fixture the
    // console declines to ask on its behalf. Only this arm is mounted here; the
    // live arm is covered by inspecting the element the absorption helper returns
    // (`frame/legacy-surfaces.test.ts`).
    const { container } = render(
      <AgentConsolePane sessionId="session-9" agentId="agent-scout" bridgeSource="fixture" />,
    );
    expect(container.textContent ?? "").toContain("running on the fixture");
  });
});

describe("agent console — the definition editor's seat", () => {
  it("states the absence rather than drawing an empty region", () => {
    const { container } = render(
      <AgentConsolePane sessionId="session-9" agentId="agent-scout" bridgeSource="fixture" />,
    );
    expect(container.textContent ?? "").toContain("definition editor has not been built here yet");
  });

  it("names no governance work anywhere a person can read", () => {
    // The slot's contract is developer-facing and reaches no screen. The rule is
    // repository-wide: governance identifiers live in comments, never in a string
    // a participant reads.
    const { container } = render(
      <AgentConsolePane sessionId="session-9" agentId="agent-scout" bridgeSource="fixture" />,
    );
    expect(container.textContent ?? "").not.toMatch(/\b(?:Spec|Plan|ADR|BL|CP)-\d/u);
  });

  it("negative control: the pane does render text that could have carried one", () => {
    // Without this, the case above would pass over a pane that rendered nothing at
    // all, which is the failure it is meant to exclude.
    const { container } = render(
      <AgentConsolePane sessionId="session-9" agentId="agent-scout" bridgeSource="fixture" />,
    );
    expect((container.textContent ?? "").length).toBeGreaterThan(80);
  });
});
