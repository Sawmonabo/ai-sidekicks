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
// The bridge below is the shipped fixture bridge with the two operations this page
// calls overridden — the `SentInvites` shape — so the refusals asserted are the
// port's own `growthUnavailable` values rather than envelopes written here.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createFixtureBridge, growthUnavailable, type ConsoleBridge } from "../bridge/index.js";
import { LIVE_ANNOUNCEMENT_HOLD_MS, ManualClock } from "../core/index.js";
import { LiveAnnouncerProvider } from "../primitives/index.js";
import { SidekickDefinitionsPage } from "./DefinitionsPage.js";
import type { SidekickDefinitionRecord } from "./definition-rows.js";

type FixtureScenario = Parameters<typeof createFixtureBridge>[0]["scenario"];
type ListOutcome = Awaited<ReturnType<ConsoleBridge["growth"]["sidekickDefinitionList"]>>;
type DeleteOutcome = Awaited<ReturnType<ConsoleBridge["growth"]["sidekickDefinitionDelete"]>>;

const EMPTY_SCENARIO: FixtureScenario = {
  id: "agents-definitions-test",
  label: "Sidekick definitions, with nothing scripted",
  purpose: "Drives the sidekicks page against a registry whose replies this file supplies.",
  sessionId: "session-agents",
  participantIdsInJoinOrder: [],
  beats: [],
  replies: [],
  startedAtIso: "2026-01-01T10:05:00.000Z",
};

function definition(overrides: Partial<SidekickDefinitionRecord> = {}): SidekickDefinitionRecord {
  return {
    definitionId: "definition-1",
    name: "Reviewer",
    description: "Reads a diff and says what it would change.",
    driverName: "claude",
    modelId: "claude-opus-4-6",
    providerAccountId: "account-work",
    effort: "high",
    executionPostureMode: "workspace-sandboxed",
    instructions: "Be exact.",
    goal: "Ship a clean diff.",
    toolAllowlist: ["read", "grep"],
    createdAt: "2026-01-01T10:00:00.000Z",
    updatedAt: "2026-01-02T11:30:00.000Z",
    ...overrides,
  };
}

/**
 * A registry that answers, and counts what it was asked.
 *
 * The list replies are consumed in order and the last one repeats, so a test can
 * say what the registry looked like BEFORE a delete and what it looks like after
 * without scripting a whole engine. The counts are what let the re-read be
 * asserted at all: "the row is gone" is also true of a page that removed it itself.
 */
class RegistryStub {
  readonly #lists: readonly ListOutcome[];
  readonly #deleteOutcome: DeleteOutcome;
  #listCallCount = 0;
  #deletedIds: string[] = [];

  public constructor(options: {
    readonly lists: readonly ListOutcome[];
    readonly deleteOutcome?: DeleteOutcome;
  }) {
    this.#lists = options.lists;
    this.#deleteOutcome = options.deleteOutcome ?? { status: "served", value: { deleted: true } };
  }

  public get listCallCount(): number {
    return this.#listCallCount;
  }

  public get deletedIds(): readonly string[] {
    return this.#deletedIds;
  }

  public bridge(): ConsoleBridge {
    const fixture = createFixtureBridge({ scenario: EMPTY_SCENARIO });
    return {
      ...fixture,
      growth: {
        ...fixture.growth,
        sidekickDefinitionList: async () => {
          const index = Math.min(this.#listCallCount, this.#lists.length - 1);
          this.#listCallCount += 1;
          return await Promise.resolve(this.#lists[index] as ListOutcome);
        },
        sidekickDefinitionDelete: async (request: { readonly definitionId: string }) => {
          this.#deletedIds = [...this.#deletedIds, request.definitionId];
          return await Promise.resolve(this.#deleteOutcome);
        },
      },
    };
  }
}

function served(definitions: readonly SidekickDefinitionRecord[]): ListOutcome {
  return { status: "served", value: definitions };
}

/**
 * Mount inside the announcer the page speaks through, on a clock that never runs
 * unless a test runs it.
 *
 * The clock is handed back because the announcer HOLDS one message and queues the
 * rest behind a deadline: on a frozen clock a second announcement is invisible in
 * the live region, so a test that only read that region could not tell one
 * announcement from two. Advancing past the hold is what makes the difference
 * observable.
 */
function renderPage(bridge: ConsoleBridge): {
  readonly container: HTMLElement;
  readonly clock: ManualClock;
} {
  const clock = new ManualClock();
  const { container } = render(
    <LiveAnnouncerProvider clock={clock}>
      <SidekickDefinitionsPage bridge={bridge} />
    </LiveAnnouncerProvider>,
  );
  return { container, clock };
}

/** Run the announcer's hold out, so anything queued behind the standing message shows. */
async function releaseAnnouncementHold(clock: ManualClock): Promise<void> {
  await act(async () => {
    clock.advance(LIVE_ANNOUNCEMENT_HOLD_MS + 1);
    await Promise.resolve();
  });
}

/** Let the read, the delete, and the re-read the delete schedules all land. */
async function settle(): Promise<void> {
  for (let pass = 0; pass < 6; pass += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function politeText(container: HTMLElement): string {
  return container.querySelector('[data-live-region="polite"]')?.textContent ?? "";
}

function savedRegionOf(container: HTMLElement): Element {
  const region = container.querySelector('[aria-label="Saved sidekicks"]');
  if (region === null) {
    throw new Error("the page rendered no saved-sidekicks region");
  }
  return region;
}

function buttonNamed(container: HTMLElement, label: string): HTMLButtonElement {
  const control = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (control === null) {
    throw new Error(`no control named ${label}`);
  }
  return control;
}

async function press(control: HTMLButtonElement | null | undefined): Promise<void> {
  await pressWithoutSettling(control);
  await settle();
}

/** Press and stop, so the frame while a call is in flight can be looked at. */
async function pressWithoutSettling(control: HTMLButtonElement | null | undefined): Promise<void> {
  await act(async () => {
    control?.click();
    await Promise.resolve();
  });
}

/** The row's own confirm — the `Delete` that is not one of the per-row openers. */
function confirmDeleteIn(container: HTMLElement): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (control) => control.textContent === "Delete" && control.getAttribute("aria-label") === null,
  );
}

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
