// What a press on the agent library does. The delete is the one act with no undo, so it asks
// first, sends the identifier not the label, and re-reads instead of dropping the row; the
// editor subject is an act too. What the page reads and announces is `AgentLibrary.read.test.ts`.

import { describe, expect, it } from "vitest";

import {
  RegistryStub,
  buttonNamed,
  confirmDeleteIn,
  definition,
  press,
  pressWithoutSettling,
  renderAgentLibrary,
  savedRegionOf,
  settle,
} from "./agent-library.test-support.js";

describe("the agent library — the editor's subject", () => {
  it("selects the record whose edit was pressed", async () => {
    const { container } = renderAgentLibrary(new RegistryStub({ lists: [[definition()]] }));
    await settle();
    const edit = buttonNamed(container, "Edit Reviewer");
    expect(edit.getAttribute("aria-pressed")).toBe("false");
    await press(edit);
    expect(buttonNamed(container, "Edit Reviewer").getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector(".meridian-saved-definition-row--open")).not.toBeNull();
  });

  it("selects the compose arm for a new definition", async () => {
    const { container } = renderAgentLibrary(new RegistryStub({ lists: [[definition()]] }));
    await settle();
    const create = container.querySelector<HTMLButtonElement>(".meridian-agent-library__new");
    expect(create?.getAttribute("aria-pressed")).toBe("false");
    await press(create);
    expect(
      container.querySelector(".meridian-agent-library__new")?.getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("negative control: selecting one record does not mark its neighbor's", async () => {
    // Otherwise both cases above would pass for a page that marked every row once any record
    // was selected.
    const { container } = renderAgentLibrary(
      new RegistryStub({
        lists: [[definition(), definition({ definitionId: "definition-2", name: "Auditor" })]],
      }),
    );
    await settle();
    await press(buttonNamed(container, "Edit Reviewer"));
    expect(buttonNamed(container, "Edit Auditor").getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelectorAll(".meridian-saved-definition-row--open")).toHaveLength(1);
  });
});

describe("the agent library — deleting one", () => {
  it("asks before it asks the daemon anything", async () => {
    const stub = new RegistryStub({ lists: [[definition()]] });
    const { container } = renderAgentLibrary(stub);
    await settle();
    await press(buttonNamed(container, "Delete Reviewer"));
    expect(container.textContent ?? "").toContain("Delete “Reviewer”?");
    expect(stub.deletedIds).toStrictEqual([]);
  });

  it("keeps the record when the question is answered no", async () => {
    const stub = new RegistryStub({ lists: [[definition()]] });
    const { container } = renderAgentLibrary(stub);
    await settle();
    await press(buttonNamed(container, "Delete Reviewer"));
    const keep = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (control) => control.textContent === "Keep",
    );
    await press(keep);
    expect(container.textContent ?? "").not.toContain("Delete “Reviewer”?");
    expect(stub.deletedIds).toStrictEqual([]);
  });

  it("sends the identifier and re-reads the registry once the daemon applied it", async () => {
    // The re-read is the assertion that matters: "the row is gone" is also true of a page that
    // dropped it locally.
    const stub = new RegistryStub({ lists: [[definition()], []] });
    const { container } = renderAgentLibrary(stub);
    await settle();
    await press(buttonNamed(container, "Delete Reviewer"));
    await press(confirmDeleteIn(container));
    expect(stub.deletedIds).toStrictEqual(["definition-1"]);
    expect(stub.listCallCount).toBe(2);
    expect(savedRegionOf(container).textContent ?? "").toContain("You have saved no sidekicks");
  });

  it("keeps the rows on screen while the re-read is in flight", async () => {
    // The `not-loaded` absence is entered once, by the first read; re-entering it would take
    // the list off screen while the deleted row is being watched.
    const stub = new RegistryStub({
      lists: [
        [definition(), definition({ definitionId: "definition-2", name: "Auditor" })],
        [definition({ definitionId: "definition-2", name: "Auditor" })],
      ],
    });
    const { container } = renderAgentLibrary(stub);
    await settle();
    await press(buttonNamed(container, "Delete Reviewer"));
    await pressWithoutSettling(confirmDeleteIn(container));
    expect(savedRegionOf(container).querySelector(".meridian-nothing--not-loaded")).toBeNull();
    expect(container.querySelectorAll(".meridian-saved-definition-row").length).toBeGreaterThan(0);
    await settle();
  });
});

describe("the agent library — while one delete is running", () => {
  it("stops every row's delete taking presses, and keeps the pending row legible", async () => {
    // Delete is the one act with no undo and the carrier runs one at a time; a control that
    // still took presses would route each into a refusal.
    const stub = new RegistryStub({
      lists: [
        [definition(), definition({ definitionId: "definition-2", name: "Auditor" })],
        [definition({ definitionId: "definition-2", name: "Auditor" })],
      ],
      holdsDeletes: true,
    });
    const { container } = renderAgentLibrary(stub);
    await settle();

    await press(buttonNamed(container, "Delete Reviewer"));
    await pressWithoutSettling(confirmDeleteIn(container));

    expect(buttonNamed(container, "Delete Auditor").disabled).toBe(true);
    // The row that is going still says so.
    expect(container.textContent ?? "").toContain("Deleting…");
    expect(stub.deletedIds).toStrictEqual(["definition-1"]);

    await stub.releaseDeletes();
    expect(stub.listCallCount).toBe(2);
  });

  it("negative control: the controls come back once the delete has settled", async () => {
    // Otherwise a page that disabled every delete on the first press and never re-enabled them
    // would pass the case above.
    const stub = new RegistryStub({
      lists: [
        [definition(), definition({ definitionId: "definition-2", name: "Auditor" })],
        [definition({ definitionId: "definition-2", name: "Auditor" })],
      ],
    });
    const { container } = renderAgentLibrary(stub);
    await settle();

    await press(buttonNamed(container, "Delete Reviewer"));
    await press(confirmDeleteIn(container));

    expect(buttonNamed(container, "Delete Auditor").disabled).toBe(false);
  });
});
