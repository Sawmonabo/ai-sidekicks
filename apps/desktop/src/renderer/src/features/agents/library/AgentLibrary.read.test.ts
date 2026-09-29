// What the agent definitions page reads, shows, and says out loud.
//
// Two of the ways this page could go wrong quietly are here. It could order rows by
// whatever order the registry answered in, which makes a list a person is scanning
// unstable between visits. And it could say nothing at all when the read lands, which
// is invisible to everyone who can see the screen and total for everyone who cannot.
//
// The third — deleting on one press, the one act here with no undo — is
// `AgentDefinitionsPage.acts.test.tsx`, with the editor seat and the pending-delete state.
//
// The registry, the announcer and the presses live in the support module beside this
// one; the registry calls are plain functions the stub there answers.

import { describe, expect, it } from "vitest";

import { liveRegionText, politeText } from "@test/helpers/live-region.js";
import {
  RegistryStub,
  buttonNamed,
  confirmDeleteIn,
  definition,
  press,
  releaseAnnouncementHold,
  renderPage,
  savedRegionOf,
  settle,
} from "./agent-library.test-support.js";

describe("the agent definitions page — the read", () => {
  it("says a read is in flight before the registry answers", () => {
    // Asserted before `settle`, which is the only moment this arm exists.
    const { container } = renderPage(new RegistryStub({ lists: [[]] }));
    const saved = savedRegionOf(container);
    expect(saved.querySelector(".meridian-nothing--not-loaded")).not.toBeNull();
    expect(saved.querySelector(".meridian-nothing--empty")).toBeNull();
  });

  it("says there are none once an empty registry answers", async () => {
    const { container } = renderPage(new RegistryStub({ lists: [[]] }));
    await settle();
    const saved = savedRegionOf(container);
    expect(saved.textContent ?? "").toContain("You have saved no sidekicks on this node");
    expect(saved.querySelector(".meridian-nothing--not-loaded")).toBeNull();
  });

  it("asks once, and does not re-ask on its own", async () => {
    const stub = new RegistryStub({ lists: [[definition()]] });
    renderPage(stub);
    await settle();
    expect(stub.listCallCount).toBe(1);
  });
});

describe("the agent definitions page — a row", () => {
  it("shows the label, the identifier, and every axis the record carries", async () => {
    const { container } = renderPage(new RegistryStub({ lists: [[definition()]] }));
    await settle();
    const saved = savedRegionOf(container);
    expect(saved.querySelector(".meridian-saved-definition-row__name")?.textContent).toBe(
      "Reviewer",
    );
    expect(saved.textContent ?? "").toContain("definition-1");
    expect(saved.querySelectorAll(".meridian-saved-definition-row__axis")).toHaveLength(10);
  });

  it("renders a wire value in mono and the console's own reading as derived", async () => {
    // The provenance signature. "The provider's default" is this console's
    // sentence about an absence, and mono would attribute it to the daemon.
    const { container } = renderPage(
      new RegistryStub({ lists: [[definition({ providerAccountId: null })]] }),
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
    // Without this, the case above would pass over a projection that reported every
    // axis as derived, which would put the daemon's own strings outside mono.
    const { container } = renderPage(new RegistryStub({ lists: [[definition()]] }));
    await settle();
    const derived = [...savedRegionOf(container).querySelectorAll(".meridian-figure--derived")].map(
      (figure) => figure.textContent ?? "",
    );
    expect(derived).not.toContain("account-work");
  });

  it("orders the list by name rather than by the order the registry answered in", async () => {
    const { container } = renderPage(
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

describe("the agent definitions page — the settlement it announces", () => {
  it("says what it read and how many, once, politely", async () => {
    const { container } = renderPage(
      new RegistryStub({
        lists: [[definition(), definition({ definitionId: "definition-2", name: "Auditor" })]],
      }),
    );
    await settle();
    expect(politeText(container)).toBe("Read 2 saved sidekicks.");
    // The interrupting lane is for room-wide refusals; a settled read is not one.
    expect(liveRegionText(container, "assertive")).toBe("");
  });

  it("speaks again when a re-read settles on something different", async () => {
    // The repetition rule is keyed on the SENTENCE, not on whether this page has
    // ever spoken. A delete that re-read to a shorter list is a different fact, and
    // the person who asked for it is the one entitled to hear that it landed.
    const stub = new RegistryStub({
      lists: [
        [definition(), definition({ definitionId: "definition-2", name: "Auditor" })],
        [definition({ definitionId: "definition-2", name: "Auditor" })],
      ],
    });
    const { container, clock } = renderPage(stub);
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
    // Without this, the case above would pass over a page that announced on every
    // settled reading — a screen reader hearing the list re-counted for a re-read that
    // changed nothing. The registry here still holds both records after the delete, so
    // the re-read answers with the list this page already spoke.
    const stub = new RegistryStub({
      lists: [[definition(), definition({ definitionId: "definition-2", name: "Auditor" })]],
    });
    const { container, clock } = renderPage(stub);
    await settle();
    expect(politeText(container)).toBe("Read 2 saved sidekicks.");
    await press(buttonNamed(container, "Delete Reviewer"));
    await press(confirmDeleteIn(container));
    expect(stub.listCallCount).toBe(2);
    await releaseAnnouncementHold(clock);
    expect(politeText(container)).toBe("");
  });
});

describe("the agent definitions page — the facts it teaches without asking anything", () => {
  it("states exactly the two a person needs before tuning one", async () => {
    const { container } = renderPage(new RegistryStub({ lists: [[]] }));
    await settle();
    expect(container.querySelectorAll(".meridian-agent-definitions__rule")).toHaveLength(2);
  });

  it("says a rename reaches nothing running, and where the sidekicks live", async () => {
    const { container } = renderPage(new RegistryStub({ lists: [[]] }));
    await settle();
    const text = container.textContent ?? "";
    expect(text).toContain("A name is a label, not an identifier");
    expect(text).toContain("no sharing, no sync, and nothing to export");
  });

  it("names no governance work anywhere a person can read", async () => {
    const { container } = renderPage(new RegistryStub({ lists: [[definition()]] }));
    await settle();
    expect(container.textContent ?? "").not.toMatch(/\b(?:Spec|Plan|ADR|BL|CP|I|T)-\d/u);
  });

  it("negative control: the page is not simply blank", async () => {
    // Without this, the case above would pass over a page that rendered nothing,
    // which is a different failure wearing the same result.
    const { container } = renderPage(new RegistryStub({ lists: [[definition()]] }));
    await settle();
    expect((container.textContent ?? "").length).toBeGreaterThan(200);
  });
});
