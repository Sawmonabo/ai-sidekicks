// What the agent library reads, shows and says out loud: rows ordered by name rather than by
// the registry's answer order, and a polite announcement when the read lands. Deleting is
// `AgentLibrary.acts.test.ts`.

import { describe, expect, it } from "vitest";

import { liveRegionText, politeText } from "@test/helpers/live-region.js";
import {
  RegistryStub,
  buttonNamed,
  confirmDeleteIn,
  definition,
  press,
  releaseAnnouncementHold,
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

  it("asks once, and does not re-ask on its own", async () => {
    const stub = new RegistryStub({ lists: [[definition()]] });
    renderAgentLibrary(stub);
    await settle();
    expect(stub.listCallCount).toBe(1);
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

  it("renders a wire value in mono and the console's own reading as derived", async () => {
    // The provenance signature: "The provider's default" is this console's sentence about an
    // absence, and mono would attribute it to the daemon.
    const { container } = renderAgentLibrary(
      new RegistryStub({ lists: [[definition({ defaultBinding: { providerAccountId: null } })]] }),
    );
    await settle();
    const saved = savedRegionOf(container);
    expect(saved.querySelector(".meridian-figure--wire")?.textContent).toContain("definition-1");
    const derived = [...saved.querySelectorAll(".meridian-figure--derived")].map(
      (figure) => figure.textContent ?? "",
    );
    expect(derived).toContain("The provider's default");
  });

  it("negative control: a pinned account is NOT rendered as the console's reading", async () => {
    // Otherwise the case above would pass for a projection that reported every axis as derived.
    const { container } = renderAgentLibrary(new RegistryStub({ lists: [[definition()]] }));
    await settle();
    const derived = [...savedRegionOf(container).querySelectorAll(".meridian-figure--derived")].map(
      (figure) => figure.textContent ?? "",
    );
    expect(derived).not.toContain("account-work");
  });

  it("orders the list by name rather than by the order the registry answered in", async () => {
    const { container } = renderAgentLibrary(
      new RegistryStub({
        lists: [
          [
            definition({ definitionId: "definition-w", name: "Writer" }),
            definition({ definitionId: "definition-a", name: "Auditor" }),
          ],
        ],
      }),
    );
    await settle();
    const names = [...container.querySelectorAll(".meridian-saved-definition-row__name")].map(
      (element) => element.textContent ?? "",
    );
    expect(names).toStrictEqual(["Auditor", "Writer"]);
  });
});

describe("the agent library — the settlement it announces", () => {
  it("says what it read and how many, once, politely", async () => {
    const { container } = renderAgentLibrary(
      new RegistryStub({
        lists: [[definition(), definition({ definitionId: "definition-2", name: "Auditor" })]],
      }),
    );
    await settle();
    expect(politeText(container)).toBe("Read 2 saved sidekicks.");
    // The assertive region is for room-wide refusals; a settled read is not one.
    expect(liveRegionText(container, "assertive")).toBe("");
  });

  it("speaks again when a re-read settles on something different", async () => {
    // The repetition rule is keyed on the sentence, not on whether the page has spoken: a
    // delete that re-read to a shorter list is a different fact.
    const stub = new RegistryStub({
      lists: [
        [definition(), definition({ definitionId: "definition-2", name: "Auditor" })],
        [definition({ definitionId: "definition-2", name: "Auditor" })],
      ],
    });
    const { container, clock } = renderAgentLibrary(stub);
    await settle();
    expect(politeText(container)).toBe("Read 2 saved sidekicks.");
    await press(buttonNamed(container, "Delete Reviewer"));
    await press(confirmDeleteIn(container));
    expect(stub.listCallCount).toBe(2);
    // Running the hold out surfaces what was queued behind the first sentence.
    await releaseAnnouncementHold(clock);
    expect(politeText(container)).toBe("Read 1 saved sidekick.");
  });

  it("negative control: a settlement that says the same thing again is silent", async () => {
    // Otherwise the case above would pass for a page that announced every settled reading. The
    // registry here still holds both records after the delete, so the re-read repeats what was
    // already spoken.
    const stub = new RegistryStub({
      lists: [[definition(), definition({ definitionId: "definition-2", name: "Auditor" })]],
    });
    const { container, clock } = renderAgentLibrary(stub);
    await settle();
    expect(politeText(container)).toBe("Read 2 saved sidekicks.");
    await press(buttonNamed(container, "Delete Reviewer"));
    await press(confirmDeleteIn(container));
    expect(stub.listCallCount).toBe(2);
    await releaseAnnouncementHold(clock);
    expect(politeText(container)).toBe("");
  });
});

describe("the agent library — the facts it teaches without asking anything", () => {
  it("states exactly the two a person needs before tuning one", async () => {
    const { container } = renderAgentLibrary(new RegistryStub({ lists: [[]] }));
    await settle();
    expect(container.querySelectorAll(".meridian-agent-library__rule")).toHaveLength(2);
  });

  it("says a rename reaches nothing running, and where the sidekicks live", async () => {
    const { container } = renderAgentLibrary(new RegistryStub({ lists: [[]] }));
    await settle();
    const text = container.textContent ?? "";
    expect(text).toContain("A name is a label, not an identifier");
    expect(text).toContain("no sharing, no sync, and nothing to export");
  });

  it("names no governance work anywhere a person can read", async () => {
    const { container } = renderAgentLibrary(new RegistryStub({ lists: [[definition()]] }));
    await settle();
    expect(container.textContent ?? "").not.toMatch(/\b(?:Spec|Plan|ADR|BL|CP|I|T)-\d/u);
  });

  it("negative control: the page is not simply blank", async () => {
    // Otherwise the case above would pass for a blank page.
    const { container } = renderAgentLibrary(new RegistryStub({ lists: [[definition()]] }));
    await settle();
    expect((container.textContent ?? "").length).toBeGreaterThan(200);
  });
});
