// Deleting a saved agent is the one act with no undo: the library asks first, sends the
// identifier rather than the label, and re-reads instead of dropping the row itself.

import { describe, expect, it } from "vitest";

import {
  RegistryStub,
  buttonNamed,
  confirmDeleteIn,
  definition,
  press,
  renderAgentLibrary,
  savedRegionOf,
} from "./AgentLibrary.test-support.js";

describe("the agent library — deleting one", () => {
  it("asks before it asks the daemon anything", async () => {
    const stub = new RegistryStub({ lists: [[definition()]] });
    const { container } = renderAgentLibrary(stub);
    await stub.settle();
    await press(stub, buttonNamed(container, "Delete Reviewer"));
    expect(container.textContent ?? "").toContain("Delete “Reviewer”?");
    expect(stub.deletedIds).toStrictEqual([]);
  });

  it("keeps the record when the question is answered no", async () => {
    const stub = new RegistryStub({ lists: [[definition()]] });
    const { container } = renderAgentLibrary(stub);
    await stub.settle();
    await press(stub, buttonNamed(container, "Delete Reviewer"));
    const keep = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (control) => control.textContent === "Keep",
    );
    await press(stub, keep);
    expect(container.textContent ?? "").not.toContain("Delete “Reviewer”?");
    expect(stub.deletedIds).toStrictEqual([]);
  });

  it("sends the identifier and re-reads the registry once the daemon applied it", async () => {
    // The re-read is the assertion that matters: "the row is gone" is also true of a page that
    // dropped it locally.
    const stub = new RegistryStub({ lists: [[definition()], []] });
    const { container } = renderAgentLibrary(stub);
    await stub.settle();
    await press(stub, buttonNamed(container, "Delete Reviewer"));
    await press(stub, confirmDeleteIn(container));
    expect(stub.deletedIds).toStrictEqual(["definition-1"]);
    expect(stub.listCallCount).toBe(2);
    expect(savedRegionOf(container).textContent ?? "").toContain("No sidekicks yet");
  });
});
