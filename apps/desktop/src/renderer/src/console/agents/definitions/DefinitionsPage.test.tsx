// The sidekicks page, against a registry that answers.
//
// Four properties carry the page, and each of them is a way it could go wrong
// quietly. It could show an empty list for a read that refused, which asserts a fact
// about a person's machine that nothing established. It could delete on one press,
// which is the one act here with no undo. It could drop the row itself instead of
// re-reading, which makes the screen agree with a delete that may not have happened.
// And it could say nothing at all when the read lands, which is invisible to
// everyone who can see the screen and total for everyone who cannot.
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
  pressWithoutSettling,
  releaseAnnouncementHold,
  renderPage,
  savedRegionOf,
  served,
  settle,
} from "./definitions-page.test-support.js";

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

describe("the sidekicks page — the editor's seat", () => {
  it("opens the seat on the record whose edit was pressed", async () => {
    const { container } = renderPage(
      new RegistryStub({ lists: [served([definition()])] }).bridge(),
    );
    await settle();
    const edit = buttonNamed(container, "Edit Reviewer");
    expect(edit.getAttribute("aria-pressed")).toBe("false");
    await press(edit);
    expect(buttonNamed(container, "Edit Reviewer").getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector(".meridian-sidekick-row--open")).not.toBeNull();
  });

  it("opens the same seat in its compose arm for a new sidekick", async () => {
    const { container } = renderPage(
      new RegistryStub({ lists: [served([definition()])] }).bridge(),
    );
    await settle();
    const create = container.querySelector<HTMLButtonElement>(".meridian-sidekicks__new");
    expect(create?.getAttribute("aria-pressed")).toBe("false");
    await press(create);
    expect(container.querySelector(".meridian-sidekicks__new")?.getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("negative control: opening one record's seat does not mark its neighbour's", async () => {
    // Without this, both cases above would pass over a page that marked every row
    // as soon as any seat was open.
    const { container } = renderPage(
      new RegistryStub({
        lists: [
          served([definition(), definition({ definitionId: "definition-2", name: "Auditor" })]),
        ],
      }).bridge(),
    );
    await settle();
    await press(buttonNamed(container, "Edit Reviewer"));
    expect(buttonNamed(container, "Edit Auditor").getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelectorAll(".meridian-sidekick-row--open")).toHaveLength(1);
  });

  it("says the editor has not been built rather than drawing a form", async () => {
    const { container } = renderPage(
      new RegistryStub({ lists: [served([definition()])] }).bridge(),
    );
    await settle();
    await press(buttonNamed(container, "Edit Reviewer"));
    const detail = container.querySelector('[aria-label="Sidekick detail"]');
    expect(detail?.textContent ?? "").toContain("sidekick editor has not been built here yet");
    expect(detail?.querySelector("input, select, textarea")).toBeNull();
  });
});

describe("the sidekicks page — deleting one", () => {
  it("asks before it asks the daemon anything", async () => {
    const stub = new RegistryStub({ lists: [served([definition()])] });
    const { container } = renderPage(stub.bridge());
    await settle();
    await press(buttonNamed(container, "Delete Reviewer"));
    expect(container.textContent ?? "").toContain("Delete “Reviewer”?");
    expect(container.textContent ?? "").toContain("keeps the configuration it was given");
    expect(stub.deletedIds).toStrictEqual([]);
  });

  it("keeps the record when the question is answered no", async () => {
    const stub = new RegistryStub({ lists: [served([definition()])] });
    const { container } = renderPage(stub.bridge());
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
    // The re-read is the assertion that matters: "the row is gone" is also true of
    // a page that dropped it locally, which would agree with a delete that may have
    // been applied differently or not at all.
    const stub = new RegistryStub({ lists: [served([definition()]), served([])] });
    const { container } = renderPage(stub.bridge());
    await settle();
    await press(buttonNamed(container, "Delete Reviewer"));
    await press(confirmDeleteIn(container));
    expect(stub.deletedIds).toStrictEqual(["definition-1"]);
    expect(stub.listCallCount).toBe(2);
    expect(savedRegionOf(container).textContent ?? "").toContain("You have saved no sidekicks");
  });

  it("keeps the rows on screen while the re-read is in flight", async () => {
    // The `not-loaded` absence is entered once, by the first read. A refresh that
    // re-entered it would take the list off the screen to show a spinner for data
    // the page is already holding — and it is the row being deleted that a person
    // is looking at while they wait.
    const stub = new RegistryStub({
      lists: [
        served([definition(), definition({ definitionId: "definition-2", name: "Auditor" })]),
        served([definition({ definitionId: "definition-2", name: "Auditor" })]),
      ],
    });
    const { container } = renderPage(stub.bridge());
    await settle();
    await press(buttonNamed(container, "Delete Reviewer"));
    await pressWithoutSettling(confirmDeleteIn(container));
    expect(savedRegionOf(container).querySelector(".meridian-nothing--not-loaded")).toBeNull();
    expect(container.querySelectorAll(".meridian-sidekick-row").length).toBeGreaterThan(0);
    await settle();
  });

  it("renders the daemon's refusal on the row and keeps the record", async () => {
    const stub = new RegistryStub({
      lists: [served([definition()])],
      deleteOutcome: growthUnavailable("sidekickDefinitionDelete"),
    });
    const { container } = renderPage(stub.bridge());
    await settle();
    await press(buttonNamed(container, "Delete Reviewer"));
    await press(confirmDeleteIn(container));
    const saved = savedRegionOf(container);
    expect(saved.querySelector(".meridian-refusal--inline")?.textContent ?? "").toContain(
      "wire-unregistered",
    );
    expect(saved.querySelector(".meridian-sidekick-row__name")?.textContent).toBe("Reviewer");
    // Nothing was re-read, because nothing changed.
    expect(stub.listCallCount).toBe(1);
  });

  it("negative control: a refused delete does not leave the row looking deleted", async () => {
    // Without this, the case above would pass over a page that removed the row and
    // then rendered the refusal beside an empty list.
    const stub = new RegistryStub({
      lists: [served([definition()])],
      deleteOutcome: growthUnavailable("sidekickDefinitionDelete"),
    });
    const { container } = renderPage(stub.bridge());
    await settle();
    await press(buttonNamed(container, "Delete Reviewer"));
    await press(confirmDeleteIn(container));
    expect(savedRegionOf(container).textContent ?? "").not.toContain("You have saved no sidekicks");
    expect(container.querySelectorAll(".meridian-sidekick-row")).toHaveLength(1);
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

describe("the sidekicks page — while one delete is running", () => {
  it("stops every row's delete taking presses, and keeps the pending row legible", async () => {
    // Delete is the one act on this page with no undo, and the carrier runs one at a
    // time. The page is where that shows: a control that still took presses would
    // route every one of them into a refusal, which is a belt rather than a design.
    const stub = new RegistryStub({
      lists: [
        served([definition(), definition({ definitionId: "definition-2", name: "Auditor" })]),
        served([definition({ definitionId: "definition-2", name: "Auditor" })]),
      ],
      holdsDeletes: true,
    });
    const { container } = renderPage(stub.bridge());
    await settle();

    await press(buttonNamed(container, "Delete Reviewer"));
    await pressWithoutSettling(confirmDeleteIn(container));

    expect(buttonNamed(container, "Delete Auditor").disabled).toBe(true);
    // The row that is going still says so, and it is the same row a person was
    // looking at when they confirmed.
    expect(container.textContent ?? "").toContain("Deleting…");
    expect(stub.deletedIds).toStrictEqual(["definition-1"]);

    await stub.releaseDeletes();
    expect(stub.listCallCount).toBe(2);
  });

  it("negative control: the controls come back once the delete has settled", async () => {
    // Without this, a page that disabled every delete on the first press and never
    // re-enabled them would satisfy the case above and leave a person unable to
    // delete anything else without reloading the window.
    const stub = new RegistryStub({
      lists: [
        served([definition(), definition({ definitionId: "definition-2", name: "Auditor" })]),
        served([definition({ definitionId: "definition-2", name: "Auditor" })]),
      ],
    });
    const { container } = renderPage(stub.bridge());
    await settle();

    await press(buttonNamed(container, "Delete Reviewer"));
    await press(confirmDeleteIn(container));

    expect(buttonNamed(container, "Delete Auditor").disabled).toBe(false);
  });
});
