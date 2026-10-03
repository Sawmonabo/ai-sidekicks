// The agent library's read arms: in flight before the registry answers, the empty registry's own
// sentence once it answers with nothing, and a row carrying its label and identifier once it
// answers with records. Deleting is `AgentLibrary.acts.test.ts`.

import { describe, expect, it } from "vitest";

import {
  RegistryStub,
  definition,
  renderAgentLibrary,
  savedRegionOf,
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
    const stub = new RegistryStub({ lists: [[]] });
    const { container } = renderAgentLibrary(stub);
    await stub.settle();
    const saved = savedRegionOf(container);
    expect(saved.textContent ?? "").toContain("No sidekicks yet");
    expect(saved.querySelector(".meridian-nothing--not-loaded")).toBeNull();
  });
});

describe("the agent library — a row", () => {
  it("shows the label and the identifier", async () => {
    const stub = new RegistryStub({ lists: [[definition()]] });
    const { container } = renderAgentLibrary(stub);
    await stub.settle();
    const saved = savedRegionOf(container);
    expect(saved.querySelector(".meridian-saved-definition-row__name")?.textContent).toBe(
      "Reviewer",
    );
    expect(saved.textContent ?? "").toContain("definition-1");
  });
});
