// What the sidekicks page reads, shows, and says out loud.
//
// Three of the four ways this page could go wrong quietly are here. It could show an
// empty list for a read that refused, which asserts a fact about a person's machine
// that nothing established. It could order rows by whatever order the registry
// answered in, which makes a list a person is scanning unstable between visits. And
// it could say nothing at all when the read lands, which is invisible to everyone who
// can see the screen and total for everyone who cannot.
//
// The fourth — deleting on one press, the one act here with no undo — is
// `SidekickDefinitionsPage.acts.test.tsx`, with the editor seat and the pending-delete state.
//
// The registry, the announcer and the presses live in the support module beside this
// one; the bridge behind them is the shipped fixture bridge with the two operations
// this page calls overridden — the `SentInvites` shape — so the refusals asserted
// are the port's own `growthUnavailable` values rather than envelopes written here.

import { describe, expect, it } from "vitest";

import { growthUnavailable } from "../../bridge/index.js";
import {
  RegistryStub,
  buttonNamed,
  confirmDeleteIn,
  definition,
  politeText,
  press,
  releaseAnnouncementHold,
  renderPage,
  savedRegionOf,
  served,
  settle,
} from "./sidekick-definitions-page.test-support.js";

describe("the sidekicks page — the read", () => {
  it("says a read is in flight before the registry answers", () => {
    // Asserted before `settle`, which is the only moment this arm exists.
    const { container } = renderPage(new RegistryStub({ lists: [served([])] }).bridge());
    const saved = savedRegionOf(container);
    expect(saved.querySelector(".meridian-nothing--not-loaded")).not.toBeNull();
    expect(saved.querySelector(".meridian-nothing--empty")).toBeNull();
  });

  it("renders the port's refusal with its code rather than an empty registry", async () => {
    const stub = new RegistryStub({ lists: [growthUnavailable("sidekickDefinitionList")] });
    const { container } = renderPage(stub.bridge());
    await settle();
    const saved = savedRegionOf(container);
    expect(saved.textContent ?? "").toContain("wire-unregistered");
    expect(saved.textContent ?? "").not.toContain("You have saved no sidekicks");
  });

  it("negative control: a served empty registry DOES say there are none", async () => {
    // Without this, the case above would pass over a page that never rendered its
    // empty state at all — the conflation in the other direction.
    const { container } = renderPage(new RegistryStub({ lists: [served([])] }).bridge());
    await settle();
    const saved = savedRegionOf(container);
    expect(saved.textContent ?? "").toContain("You have saved no sidekicks on this node");
    expect(saved.textContent ?? "").not.toContain("wire-unregistered");
  });

  it("asks once, and does not re-ask on its own", async () => {
    const stub = new RegistryStub({ lists: [served([definition()])] });
    renderPage(stub.bridge());
    await settle();
    expect(stub.listCallCount).toBe(1);
  });
});

describe("the sidekicks page — a row", () => {
  it("shows the label, the identifier, and every axis the record carries", async () => {
    const { container } = renderPage(
      new RegistryStub({ lists: [served([definition()])] }).bridge(),
    );
    await settle();
    const saved = savedRegionOf(container);
    expect(saved.querySelector(".meridian-sidekick-row__name")?.textContent).toBe("Reviewer");
    expect(saved.textContent ?? "").toContain("definition-1");
    expect(saved.querySelectorAll(".meridian-sidekick-row__axis")).toHaveLength(10);
  });

  it("renders a wire value in mono and the console's own reading as derived", async () => {
    // Rule 4's provenance signature. "The provider's default" is this console's
    // sentence about an absence, and mono would attribute it to the daemon.
    const { container } = renderPage(
      new RegistryStub({ lists: [served([definition({ providerAccountId: null })])] }).bridge(),
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
    const { container } = renderPage(
      new RegistryStub({ lists: [served([definition()])] }).bridge(),
    );
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
          served([
            definition({ definitionId: "definition-w", name: "Writer" }),
            definition({ definitionId: "definition-a", name: "Auditor" }),
          ]),
        ],
      }).bridge(),
    );
    await settle();
    const names = [...container.querySelectorAll(".meridian-sidekick-row__name")].map(
      (element) => element.textContent ?? "",
    );
    expect(names).toStrictEqual(["Auditor", "Writer"]);
  });
});

describe("the sidekicks page — the settlement it announces", () => {
  it("says what it read and how many, once, politely", async () => {
    const { container } = renderPage(
      new RegistryStub({
        lists: [
          served([definition(), definition({ definitionId: "definition-2", name: "Auditor" })]),
        ],
      }).bridge(),
    );
    await settle();
    expect(politeText(container)).toBe("Read 2 saved sidekicks.");
    // The interrupting lane is for room-wide refusals; a settled read is not one.
    expect(container.querySelector('[data-live-region="assertive"]')?.textContent ?? "").toBe("");
  });

  it("speaks a refusal's sentence when the read refused", async () => {
    const { container } = renderPage(
      new RegistryStub({ lists: [growthUnavailable("sidekickDefinitionList")] }).bridge(),
    );
    await settle();
    expect(politeText(container)).toContain("Not checked");
  });

  it("speaks again when a re-read settles on something different", async () => {
    // The repetition rule is keyed on the SENTENCE, not on whether this page has
    // ever spoken. A delete that re-read to a shorter list is a different fact, and
    // the person who asked for it is the one entitled to hear that it landed.
    const stub = new RegistryStub({
      lists: [
        served([definition(), definition({ definitionId: "definition-2", name: "Auditor" })]),
        served([definition({ definitionId: "definition-2", name: "Auditor" })]),
      ],
    });
    const { container, clock } = renderPage(stub.bridge());
    await settle();
    expect(politeText(container)).toBe("Read 2 saved sidekicks.");
    await press(buttonNamed(container, "Delete Reviewer"));
    await press(confirmDeleteIn(container));
    expect(stub.listCallCount).toBe(2);
    // Running the hold out surfaces what was queued behind the first sentence.
    await releaseAnnouncementHold(clock);
    expect(politeText(container)).toBe("Read 1 saved sidekick.");
  });

  it("speaks a refusal that arrives after a read this page already announced", async () => {
    // The case a once-ever guard loses entirely: the list read, the delete landed,
    // and the re-read behind it refused. A sighted person sees the refusal; before
    // the guard became sentence-keyed, everybody else heard the first count and
    // then silence for the rest of the page's life.
    const stub = new RegistryStub({
      lists: [
        served([definition(), definition({ definitionId: "definition-2", name: "Auditor" })]),
        growthUnavailable("sidekickDefinitionList"),
      ],
    });
    const { container, clock } = renderPage(stub.bridge());
    await settle();
    expect(politeText(container)).toBe("Read 2 saved sidekicks.");
    await press(buttonNamed(container, "Delete Reviewer"));
    await press(confirmDeleteIn(container));
    await releaseAnnouncementHold(clock);
    expect(politeText(container)).toContain("Not checked");
  });

  it("negative control: a settlement that says the same thing again is silent", async () => {
    // Without this, the two cases above would pass over a page that announced on
    // every settled reading — a screen reader hearing the list re-counted for a
    // re-read that changed nothing. The delete below refuses, so the re-read that
    // follows it answers with the list this page already spoke.
    const stub = new RegistryStub({
      lists: [
        served([definition(), definition({ definitionId: "definition-2", name: "Auditor" })]),
      ],
      deleteOutcome: growthUnavailable("sidekickDefinitionDelete"),
    });
    const { container, clock } = renderPage(stub.bridge());
    await settle();
    expect(politeText(container)).toBe("Read 2 saved sidekicks.");
    await press(buttonNamed(container, "Delete Reviewer"));
    await press(confirmDeleteIn(container));
    await releaseAnnouncementHold(clock);
    expect(politeText(container)).toBe("");
  });
});

describe("the sidekicks page — the facts it teaches without asking anything", () => {
  it("states exactly the three a person needs before tuning one", async () => {
    const { container } = renderPage(new RegistryStub({ lists: [served([])] }).bridge());
    await settle();
    expect(container.querySelectorAll(".meridian-sidekicks__rule")).toHaveLength(3);
  });

  it("says a rename reaches nothing running, and that editing is therefore safe", async () => {
    const { container } = renderPage(new RegistryStub({ lists: [served([])] }).bridge());
    await settle();
    const text = container.textContent ?? "";
    expect(text).toContain("A name is a label, not an identifier");
    expect(text).toContain("Nothing already attached");
    expect(text).toContain("no sharing, no sync, and nothing to export");
  });

  it("names no governance work anywhere a person can read", async () => {
    const { container } = renderPage(
      new RegistryStub({ lists: [served([definition()])] }).bridge(),
    );
    await settle();
    expect(container.textContent ?? "").not.toMatch(/\b(?:Spec|Plan|ADR|BL|CP|I|T)-\d/u);
  });

  it("negative control: the page is not simply blank", async () => {
    // Without this, the case above would pass over a page that rendered nothing,
    // which is a different failure wearing the same result.
    const { container } = renderPage(
      new RegistryStub({ lists: [served([definition()])] }).bridge(),
    );
    await settle();
    expect((container.textContent ?? "").length).toBeGreaterThan(200);
  });
});
