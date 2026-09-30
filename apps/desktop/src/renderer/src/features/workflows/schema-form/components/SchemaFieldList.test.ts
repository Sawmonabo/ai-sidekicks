// The collection field list: what a repeated control is called, where its findings land, and
// what its add and remove controls are called. Driven through the real mount, since a
// fabricated list descriptor would pass with the mapper deleted.

import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  addListEntry,
  answerEveryCollection,
  composedAnswer,
  listFieldset,
  renderForm,
  reportedIssueTexts,
} from "./SchemaFormWithReadout.test-support.js";

afterEach(cleanup);

/**
 * A schema whose only valid answer is a present empty collection: the root demands a member
 * and the array accepts no entries, so `{ reviewers: [] }` is the one value it takes.
 */
const PRESENT_EMPTY_SCHEMA = {
  type: "object",
  minProperties: 1,
  properties: {
    reviewers: { type: "array", title: "Reviewers", items: { type: "string" }, maxItems: 0 },
  },
} as const;

describe("the collection a schema-derived form draws", () => {
  it("draws an answered list with the control that adds an entry and none that removes one yet", async () => {
    const container = await renderForm({
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

  it("draws a yes-or-no entry as the box a position always holds a value for", async () => {
    // The collection is optional, but a position inside it cannot be left out: the entry is on
    // screen once add is pressed. So its boolean draws as a box, not the three-state choice a
    // standalone optional boolean gets.
    answerEveryCollection(
      await renderForm({
        type: "object",
        properties: {
          flags: { type: "array", title: "Flags", items: { type: "boolean" } },
          notify: { type: "boolean", title: "Notify" },
        },
      }),
    );
    addListEntry("Flags");

    expect(screen.getByLabelText("Flags, entry 1")).toHaveProperty("type", "checkbox");
    // The control: the same optional kind standing on its own, where the third state is honest.
    expect(screen.getByLabelText("Notify").tagName).toBe("SELECT");
  });

  it("names each collection's add control after the collection it adds to", async () => {
    // A legend is not part of a button's accessible name, so two lists with the same visible
    // text would give indistinguishable buttons.
    answerEveryCollection(
      await renderForm({
        type: "object",
        properties: {
          reviewers: { type: "array", title: "Reviewers", items: { type: "string" } },
          approvers: { type: "array", title: "Approvers", items: { type: "string" } },
        },
      }),
    );

    expect(screen.getByRole("button", { name: "Add an entry to Reviewers" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Add an entry to Approvers" })).toBeDefined();
    // The visible text is unchanged; only the spoken name carries the collection.
    expect(screen.queryAllByRole("button", { name: "Add an entry" })).toHaveLength(0);
  });

  it("names each entry's remove control after the entry it removes", async () => {
    // The same for remove: the first entry of every collection is "entry 1".
    answerEveryCollection(
      await renderForm({
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

  it("names each repeated control by its collection and the position it sits at", async () => {
    const container = await renderForm({
      type: "object",
      properties: { reviewers: { type: "array", title: "Reviewers", items: { type: "string" } } },
    });
    answerEveryCollection(container);
    addListEntry("Reviewers");
    addListEntry("Reviewers");

    expect(screen.getByRole("textbox", { name: "Reviewers, entry 1" })).toBeDefined();
    expect(screen.getByRole("textbox", { name: "Reviewers, entry 2" })).toBeDefined();
    // Spoken rather than drawn: the legend and list order already show it.
    expect(container.querySelector(".meridian-schema-list__item label")?.className).toContain(
      "meridian-visually-hidden",
    );
  });

  it("renders an indexed finding under the entry it is about rather than on the whole list", async () => {
    const container = await renderForm({
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
    // The collection itself has nothing wrong, so no message may be drawn against its fieldset.
    expect(
      container.querySelector(".meridian-schema-list > .meridian-schema-field__issues"),
    ).toBeNull();
  });

  it("opens an optional collection unanswered and makes it a present empty array once answered", async () => {
    const container = await renderForm(PRESENT_EMPTY_SCHEMA);
    const list = listFieldset(container);

    // Unanswered: absent from the answer, offering only the control that answers it and no add.
    expect(composedAnswer(container)).toEqual({});
    expect(within(list).queryByRole("button", { name: "Add an entry to Reviewers" })).toBeNull();

    fireEvent.click(within(list).getByRole("button", { name: "Answer this section" }));

    expect(composedAnswer(container)).toEqual({ reviewers: [] });
    expect(reportedIssueTexts(container)).toEqual([]);
    expect(within(list).getByRole("button", { name: "Add an entry to Reviewers" })).toBeDefined();

    fireEvent.click(within(list).getByRole("button", { name: "Leave unanswered" }));

    expect(composedAnswer(container)).toEqual({});
  });

  it("keeps an answered collection present after its last entry is removed", async () => {
    // Present-empty and absent are two states; only the activation control moves between them.
    const container = await renderForm({
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

  it("draws a required collection answered from the mount, with no control that takes it back", async () => {
    // The schema demands the array, so the control is absent rather than drawn and inert.
    const container = await renderForm({
      type: "object",
      properties: { reviewers: { type: "array", title: "Reviewers", items: { type: "string" } } },
      required: ["reviewers"],
    });
    const list = listFieldset(container);

    expect(composedAnswer(container)).toEqual({ reviewers: [] });
    expect(within(list).queryByRole("button", { name: "Leave unanswered" })).toBeNull();
    expect(within(list).getByRole("button", { name: "Add an entry to Reviewers" })).toBeDefined();
  });

  it("names the collection's description in the fieldset's description, ahead of any finding", async () => {
    // The description is attached to the fieldset, so it is heard among the entry controls.
    const container = await renderForm({
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

  it("names the description alone where nothing is wrong, and the finding alone where there is none", async () => {
    const described = await renderForm({
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

    const undescribed = await renderForm({
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

  it("keeps an entry's finding off a member whose own name reads like that entry's position", async () => {
    // Negative control for the path representation: joined with a dot, the property `items.0`
    // and entry 0 of `items` are one string, so the finding would draw under both controls.
    const container = await renderForm({
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
