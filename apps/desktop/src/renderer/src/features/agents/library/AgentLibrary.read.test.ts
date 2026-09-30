// The agent library's read arms: in flight before the registry answers, the empty registry's own
// sentence once it answers with nothing, and a row carrying its label, identifier and every axis
// once it answers with records. Deleting is `AgentLibrary.acts.test.ts`.

import { describe, expect, it } from "vitest";

import {
  RegistryStub,
  definition,
  renderAgentLibrary,
  savedRegionOf,
  settle,
} from "./agent-library.test-support.js";

describe("the agent library — the read", () => {
  it("says a read is in flight before the registry answers", () => {
    // Asserted before `settle`, the only moment this arm exists.
    const { container } = renderAgentLibrary(new RegistryStub({ lists: [[]] }));
    const saved = savedRegionOf(container);
    expect(saved.querySelector(".meridian-nothing--not-loaded")).not.toBeNull();
    expect(saved.querySelector(".meridian-nothing--empty")).toBeNull();
  });

  it("says there are none once an empty registry answers", async () => {
    const { container } = renderAgentLibrary(new RegistryStub({ lists: [[]] }));
    await settle();
    const saved = savedRegionOf(container);
    expect(saved.textContent ?? "").toContain("You have saved no sidekicks on this node");
    expect(saved.querySelector(".meridian-nothing--not-loaded")).toBeNull();
  });
});

describe("the agent library — a row", () => {
  it("shows the label, the identifier, and every axis the record carries", async () => {
    const { container } = renderAgentLibrary(new RegistryStub({ lists: [[definition()]] }));
    await settle();
    const saved = savedRegionOf(container);
    expect(saved.querySelector(".meridian-saved-definition-row__name")?.textContent).toBe(
      "Reviewer",
    );
    expect(saved.textContent ?? "").toContain("definition-1");
    expect(saved.querySelectorAll(".meridian-saved-definition-row__axis")).toHaveLength(10);
  });
});
