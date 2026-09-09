// What an empty roster says, beside the module that says it.
//
// These two cases were carried by `agent-card/AgentCard.test.tsx` while this
// component stayed at the family root — a suite about the absence of every agent
// filed under the module that draws one, which is exactly the co-location rule this
// package states for `console/`.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AgentRosterEmpty } from "./AgentRosterEmpty.js";

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
