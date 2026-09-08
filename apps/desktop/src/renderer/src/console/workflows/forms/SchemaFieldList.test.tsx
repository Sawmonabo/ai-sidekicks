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

import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { addListEntry, renderForm } from "./SchemaFormHost.test-support.js";

afterEach(cleanup);

describe("the collection a schema-derived form draws", () => {
  it("draws a list with the control that adds an entry and none that removes one yet", () => {
    const container = renderForm({
      type: "object",
      properties: { reviewers: { type: "array", title: "Reviewers", items: { type: "string" } } },
    });

    expect(container.querySelector(".meridian-schema-list__legend")?.textContent).toContain(
      "Reviewers",
    );
    expect(screen.getByRole("button", { name: "Add an entry to Reviewers" })).toBeDefined();
    expect(container.querySelectorAll(".meridian-schema-list__item")).toHaveLength(0);
  });

  it("names each collection's add control after the collection it adds to", () => {
    // A fieldset legend is not part of a button's accessible name, so two lists drawn with
    // the same visible text are two controls a person navigating between buttons cannot
    // tell apart — and pressing one of them adds an entry somewhere they did not choose.
    renderForm({
      type: "object",
      properties: {
        reviewers: { type: "array", title: "Reviewers", items: { type: "string" } },
        approvers: { type: "array", title: "Approvers", items: { type: "string" } },
      },
    });

    expect(screen.getByRole("button", { name: "Add an entry to Reviewers" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Add an entry to Approvers" })).toBeDefined();
    // The visible text is unchanged, so no control on either fieldset got longer; what
    // moved is the name spoken for it, and no button is left carrying the bare one.
    expect(screen.queryAllByRole("button", { name: "Add an entry" })).toHaveLength(0);
  });

  it("names each entry's remove control after the entry it removes", () => {
    // The same defect one control over, and it arrives the moment somebody adds anything:
    // the first entry of every collection on the form is "entry 1".
    renderForm({
      type: "object",
      properties: {
        reviewers: { type: "array", title: "Reviewers", items: { type: "string" } },
        approvers: { type: "array", title: "Approvers", items: { type: "string" } },
      },
    });
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
    addListEntry("Items");

    const dottedControl = screen.getByLabelText("A member named like a position");
    const entryControl = container.querySelector(".meridian-schema-list__item input");
    const entryDescribedBy = entryControl?.getAttribute("aria-describedby") ?? "";

    expect(document.getElementById(entryDescribedBy)?.textContent ?? "").not.toBe("");
    expect(dottedControl.getAttribute("aria-describedby")).toBeNull();
    expect(container.querySelectorAll(".meridian-schema-field__issues")).toHaveLength(1);
  });
});
