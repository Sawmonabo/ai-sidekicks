// What a press on the sidekicks page does, and what it refuses to do on one press.
//
// The act worth the file is the delete: it is the only one here with no undo, so it
// asks first, it sends the identifier rather than the label, and it RE-READS instead
// of dropping the row — because a screen that agrees with a delete that may not have
// happened is worse than one that waits. The rows stay legible while it runs, and a
// refusal lands on the row rather than replacing it.
//
// The editor seat is here for the same reason: what a press opens, and on which
// record, is an act and not a reading.
//
// What the page reads, shows, and announces is `SidekickDefinitionsPage.read.test.tsx`.
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
  press,
  pressWithoutSettling,
  renderPage,
  savedRegionOf,
  served,
  settle,
} from "./sidekick-definitions-page.test-support.js";

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
