// The collection surface: what a repeated control is called, where its findings land, and
// what the two controls that change how many are called.
//
// SPLIT FROM `SchemaForm.test.tsx` because the two are different subjects and the file had
// stopped being one reading. That suite is about the form — which control a member draws,
// where a finding addressed to a member, a group, or the whole answer is rendered. This
// one is about a collection: a fieldset holding positions rather than names, whose entries
// are named by where they sit and whose add and remove controls are named for it.
//
// Driven through the same real mount, for that suite's reason: a case fed a fabricated
// list descriptor would pass with the mapper deleted.

import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  addListEntry,
  answerEveryCollection,
  composedAnswer,
  listFieldset,
  renderForm,
  reportedIssueTexts,
} from "./SchemaFormHost.test-support.js";

afterEach(cleanup);

/**
 * The shape a present EMPTY collection is the only answer to.
 *
 * The root demands at least one member and the collection accepts no entries, so
 * `{ reviewers: [] }` is the one value this schema takes. Projected through the unanswered
 * value, a zero-row draft was omitted for being optional, adding a row broke `maxItems`,
 * and the drawn form could never reach the single state that satisfies its own schema.
 */
const PRESENT_EMPTY_SCHEMA = {
  type: "object",
  minProperties: 1,
  properties: {
    reviewers: { type: "array", title: "Reviewers", items: { type: "string" }, maxItems: 0 },
  },
} as const;

describe("the collection a schema-derived form draws", () => {
  it("draws an answered list with the control that adds an entry and none that removes one yet", () => {
    const container = renderForm({
      type: "object",
      properties: { reviewers: { type: "array", title: "Reviewers", items: { type: "string" } } },
    });
    answerEveryCollection(container);

    expect(container.querySelector(".meridian-schema-list__legend")?.textContent).toContain(
      "Reviewers",
    );
    expect(screen.getByRole("button", { name: "Add an entry to Reviewers" })).toBeDefined();
    expect(container.querySelectorAll(".meridian-schema-list__item")).toHaveLength(0);
  });

  it("draws a yes-or-no entry as the box a position always holds a value for", () => {
    // WHERE REQUIREDNESS AND "MAY BE LEFT OUT" PART COMPANY, which is the one thing the
    // entry descriptor exists to say. This collection is OPTIONAL, so the answer may leave
    // `flags` out entirely — but a POSITION inside it cannot be left out: the entry is on
    // the screen from the moment somebody presses add. Read off the collection's own
    // requiredness, the entry would have drawn the three-state choice a standalone
    // optional boolean draws, and offered an unanswered option that writes nothing into a
    // slot that has to hold something.
    answerEveryCollection(
      renderForm({
        type: "object",
        properties: {
          flags: { type: "array", title: "Flags", items: { type: "boolean" } },
          notify: { type: "boolean", title: "Notify" },
        },
      }),
    );
    addListEntry("Flags");

    expect(screen.getByLabelText("Flags, entry 1")).toHaveProperty("type", "checkbox");
    // The control: the same kind, equally optional, standing on its own — where absence IS
    // available and the third state is therefore the honest one. Without this, an entry
    // drawn as a box would look like the rule rather than the exception to it.
    expect(screen.getByLabelText("Notify").tagName).toBe("SELECT");
  });

  it("names each collection's add control after the collection it adds to", () => {
    // A fieldset legend is not part of a button's accessible name, so two lists drawn with
    // the same visible text are two controls a person navigating between buttons cannot
    // tell apart — and pressing one of them adds an entry somewhere they did not choose.
    answerEveryCollection(
      renderForm({
        type: "object",
        properties: {
          reviewers: { type: "array", title: "Reviewers", items: { type: "string" } },
          approvers: { type: "array", title: "Approvers", items: { type: "string" } },
        },
      }),
    );

    expect(screen.getByRole("button", { name: "Add an entry to Reviewers" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Add an entry to Approvers" })).toBeDefined();
    // The visible text is unchanged, so no control on either fieldset got longer; what
    // moved is the name spoken for it, and no button is left carrying the bare one.
    expect(screen.queryAllByRole("button", { name: "Add an entry" })).toHaveLength(0);
  });

  it("names each entry's remove control after the entry it removes", () => {
    // The same defect one control over, and it arrives the moment somebody adds anything:
    // the first entry of every collection on the form is "entry 1".
    answerEveryCollection(
      renderForm({
        type: "object",
        properties: {
          reviewers: { type: "array", title: "Reviewers", items: { type: "string" } },
          approvers: { type: "array", title: "Approvers", items: { type: "string" } },
        },
      }),
    );
    addListEntry("Reviewers");
    addListEntry("Approvers");

    expect(screen.getByRole("button", { name: "Remove Reviewers, entry 1" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Remove Approvers, entry 1" })).toBeDefined();
    expect(screen.queryAllByRole("button", { name: "Remove entry 1" })).toHaveLength(0);
  });

  it("names each repeated control by its collection and the position it sits at", () => {
    const container = renderForm({
      type: "object",
      properties: { reviewers: { type: "array", title: "Reviewers", items: { type: "string" } } },
    });
    answerEveryCollection(container);
    addListEntry("Reviewers");
    addListEntry("Reviewers");

    expect(screen.getByRole("textbox", { name: "Reviewers, entry 1" })).toBeDefined();
    expect(screen.getByRole("textbox", { name: "Reviewers, entry 2" })).toBeDefined();
    // Spoken rather than drawn: the legend already names the collection and the ordered
    // list already draws the position, so a visible label would say both a second time.
    expect(container.querySelector(".meridian-schema-list__item label")?.className).toContain(
      "meridian-visually-hidden",
    );
  });

  it("renders an indexed finding under the entry it is about rather than on the whole list", () => {
    const container = renderForm({
      type: "object",
      properties: {
        reviewers: { type: "array", title: "Reviewers", items: { type: "string", minLength: 3 } },
      },
    });
    answerEveryCollection(container);
    addListEntry("Reviewers");

    const entryControl = container.querySelector(".meridian-schema-list__item input");
    const describedBy = entryControl?.getAttribute("aria-describedby") ?? "";

    expect(describedBy).not.toBe("");
    expect(document.getElementById(describedBy)?.textContent ?? "").not.toBe("");
    // The collection itself has nothing wrong with it — `minItems` and its siblings are
    // what a list-level finding is — so a message drawn against the fieldset here would
    // be one nobody could attribute to an entry.
    expect(
      container.querySelector(".meridian-schema-list > .meridian-schema-field__issues"),
    ).toBeNull();
  });

  it("opens an optional collection unanswered and makes it a present empty array once answered", () => {
    const container = renderForm(PRESENT_EMPTY_SCHEMA);
    const list = listFieldset(container);

    // Unanswered: absent from the answer, offering the one control that answers it and
    // none that adds an entry — a row under a collection nobody is answering would be a
    // row whose value reaches nothing, which is the rule an optional group already keeps.
    expect(composedAnswer(container)).toEqual({});
    expect(within(list).queryByRole("button", { name: "Add an entry to Reviewers" })).toBeNull();

    fireEvent.click(within(list).getByRole("button", { name: "Answer this section" }));

    expect(composedAnswer(container)).toEqual({ reviewers: [] });
    expect(reportedIssueTexts(container)).toEqual([]);
    expect(within(list).getByRole("button", { name: "Add an entry to Reviewers" })).toBeDefined();

    fireEvent.click(within(list).getByRole("button", { name: "Leave unanswered" }));

    expect(composedAnswer(container)).toEqual({});
  });

  it("keeps an answered collection present after its last entry is removed", () => {
    // Present-empty and absent are two states, and only the activation control moves
    // between them: a collection somebody answered and then emptied is an empty array,
    // not a member they never answered.
    const container = renderForm({
      type: "object",
      properties: { reviewers: { type: "array", title: "Reviewers", items: { type: "string" } } },
    });
    const list = listFieldset(container);
    fireEvent.click(within(list).getByRole("button", { name: "Answer this section" }));
    addListEntry("Reviewers");
    fireEvent.click(screen.getByRole("button", { name: "Remove Reviewers, entry 1" }));

    expect(composedAnswer(container)).toEqual({ reviewers: [] });

    fireEvent.click(within(list).getByRole("button", { name: "Leave unanswered" }));

    expect(composedAnswer(container)).toEqual({});
  });

  it("draws a required collection answered from the mount, with no control that takes it back", () => {
    // The other half of the rule, unchanged: the schema demands the array, so there is no
    // state the control could reach and it is absent rather than drawn and inert.
    const container = renderForm({
      type: "object",
      properties: { reviewers: { type: "array", title: "Reviewers", items: { type: "string" } } },
      required: ["reviewers"],
    });
    const list = listFieldset(container);

    expect(composedAnswer(container)).toEqual({ reviewers: [] });
    expect(within(list).queryByRole("button", { name: "Leave unanswered" })).toBeNull();
    expect(within(list).getByRole("button", { name: "Add an entry to Reviewers" })).toBeDefined();
  });

  it("names the collection's description in the fieldset's description, ahead of any finding", () => {
    // A person moving between the entry, add, and remove controls hears the legend and
    // never the author's instructions, which the fieldset drew visibly and named nowhere.
    const container = renderForm({
      type: "object",
      properties: {
        reviewers: {
          type: "array",
          title: "Reviewers",
          description: "Two at least.",
          items: { type: "string" },
          minItems: 2,
        },
      },
      required: ["reviewers"],
    });
    const describedBy = (listFieldset(container).getAttribute("aria-describedby") ?? "").split(" ");

    expect(describedBy).toHaveLength(2);
    expect(document.getElementById(describedBy[0] ?? "")?.textContent).toBe("Two at least.");
    expect(document.getElementById(describedBy[1] ?? "")?.textContent ?? "").not.toBe("");
  });

  it("names the description alone where nothing is wrong, and the finding alone where there is none", () => {
    const described = renderForm({
      type: "object",
      properties: {
        reviewers: {
          type: "array",
          title: "Reviewers",
          description: "Two at least.",
          items: { type: "string" },
        },
      },
      required: ["reviewers"],
    });
    const describedOnly = (listFieldset(described).getAttribute("aria-describedby") ?? "").split(
      " ",
    );

    expect(describedOnly).toHaveLength(1);
    expect(document.getElementById(describedOnly[0] ?? "")?.textContent).toBe("Two at least.");

    const undescribed = renderForm({
      type: "object",
      properties: {
        reviewers: { type: "array", title: "Reviewers", items: { type: "string" }, minItems: 2 },
      },
      required: ["reviewers"],
    });
    const issuesOnly = (listFieldset(undescribed).getAttribute("aria-describedby") ?? "").split(
      " ",
    );

    expect(issuesOnly).toHaveLength(1);
    expect(document.getElementById(issuesOnly[0] ?? "")?.textContent ?? "").not.toBe("");
  });

  it("keeps an entry's finding off a member whose own name reads like that entry's position", () => {
    // The negative control for the path representation. Joined with a dot, the property
    // literally named `items.0` and the first entry of the array named `items` are ONE
    // string, so the entry's finding was drawn under both controls — under a control whose
    // value the schema had said nothing about.
    const container = renderForm({
      type: "object",
      properties: {
        "items.0": { type: "string", title: "A member named like a position" },
        items: { type: "array", title: "Items", items: { type: "string", minLength: 3 } },
      },
    });
    answerEveryCollection(container);
    addListEntry("Items");

    const dottedControl = screen.getByLabelText("A member named like a position");
    const entryControl = container.querySelector(".meridian-schema-list__item input");
    const entryDescribedBy = entryControl?.getAttribute("aria-describedby") ?? "";

    expect(document.getElementById(entryDescribedBy)?.textContent ?? "").not.toBe("");
    expect(dottedControl.getAttribute("aria-describedby")).toBeNull();
    expect(container.querySelectorAll(".meridian-schema-field__issues")).toHaveLength(1);
  });
});
