// The form as a person meets it: six controls from six member shapes, a group, a list,
// and — the bullet this whole subtree exists for — an out-of-set schema opening the raw
// editor instead of refusing.
//
// Driven through the real hook rather than a hand-built state, because the two are one
// surface: a test that fed the component a fabricated plan would pass with the mapper
// deleted.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SchemaForm } from "./SchemaForm.js";
import { useSchemaForm } from "./use-schema-form.js";

afterEach(cleanup);

/** Where the host below writes the answer the controls composed, for a case to read. */
const COMPOSED_ANSWER_CLASS = "composed-answer";

/**
 * The form, mounted over one schema through its own hook.
 *
 * It writes the composed answer out beside the controls, because the value a submission
 * would carry is the only thing that settles what a control MEANT: a select that looks
 * right and reports `undefined` renders identically to one that reports a member.
 */
function FormHost(props: { readonly inputSchema: unknown }): React.JSX.Element {
  const form = useSchemaForm(props.inputSchema);
  return (
    <>
      <SchemaForm form={form} />
      <output className={COMPOSED_ANSWER_CLASS}>{JSON.stringify(form.answer)}</output>
    </>
  );
}

/** Render one schema's form and hand back the container it drew into. */
function renderForm(inputSchema: unknown): HTMLElement {
  const { container } = render(<FormHost inputSchema={inputSchema} />);
  return container;
}

/** The answer the drawn controls have composed so far, read back as a value. */
function composedAnswer(container: HTMLElement): unknown {
  return JSON.parse(container.querySelector(`.${COMPOSED_ANSWER_CLASS}`)?.textContent ?? "null");
}

/** Press the control that adds one entry to the only list on the drawn form. */
function addListEntry(): void {
  fireEvent.click(screen.getByRole("button", { name: "Add an entry" }));
}

describe("the schema-derived form", () => {
  it("draws one labelled control for each of the six kinds", () => {
    renderForm({
      type: "object",
      properties: {
        title: { type: "string", title: "Title" },
        notes: { type: "string", format: "long_text", title: "Notes" },
        count: { type: "integer", title: "Count" },
        approved: { type: "boolean", title: "Approved" },
        severity: { type: "string", enum: ["low", "high"], title: "Severity" },
        evidence: { type: "string", format: "artifact", title: "Evidence" },
      },
    });

    expect(screen.getByLabelText("Title").tagName).toBe("INPUT");
    expect(screen.getByLabelText("Notes").tagName).toBe("TEXTAREA");
    expect(screen.getByLabelText("Count")).toHaveProperty("type", "number");
    expect(screen.getByLabelText("Approved")).toHaveProperty("type", "checkbox");
    expect(screen.getByLabelText("Severity").tagName).toBe("SELECT");
    expect(screen.getByLabelText("Evidence")).toHaveProperty("type", "text");
  });

  it("offers the enumeration's members and one unanswered option that is not one of them", () => {
    renderForm({
      type: "object",
      properties: { severity: { type: "string", enum: ["low", "high"], title: "Severity" } },
    });

    const options = [...screen.getByLabelText("Severity").querySelectorAll("option")];

    expect(options.map((option) => option.textContent)).toEqual(["Not answered", "low", "high"]);
    // The members are offered under their POSITIONS, so the unanswered option's value is
    // not a string any enumeration can contain: it is the one value that is not an index.
    expect(options.map((option) => option.value)).toEqual(["", "0", "1"]);
  });

  it("submits an enumeration member the schema spells empty rather than reading it as no answer", () => {
    const container = renderForm({
      type: "object",
      properties: { severity: { type: "string", enum: ["", "high"], title: "Severity" } },
    });
    const severity = screen.getByLabelText("Severity");
    const emptyMemberOption = [...severity.querySelectorAll("option")].find(
      (option) => option.textContent === "",
    );

    fireEvent.change(severity, { target: { value: emptyMemberOption?.value } });

    expect(composedAnswer(container)).toEqual({ severity: "" });
  });

  it("says which members the schema requires without deciding whether they are answered", () => {
    const container = renderForm({
      type: "object",
      properties: { title: { type: "string", title: "Title" } },
      required: ["title"],
    });

    expect(container.querySelector(".meridian-schema-field__required")?.textContent).toContain(
      "required",
    );
  });

  it("renders the schema's own findings against the control they are about", () => {
    const container = renderForm({
      type: "object",
      properties: { count: { type: "number", title: "Count" } },
      required: ["count"],
    });

    const issues = container.querySelector(".meridian-schema-field__issues");

    expect(issues?.textContent ?? "").not.toBe("");
  });

  it("attaches a member's description to its control rather than leaving it beside one", () => {
    renderForm({
      type: "object",
      properties: { title: { type: "string", title: "Title", description: "One line." } },
    });

    const describedBy = screen.getByLabelText("Title").getAttribute("aria-describedby") ?? "";

    expect(describedBy).not.toBe("");
    expect(document.getElementById(describedBy.split(" ")[0] ?? "")?.textContent).toBe("One line.");
  });

  it("draws a group as a named fieldset holding its own members", () => {
    const container = renderForm({
      type: "object",
      properties: {
        release: {
          type: "object",
          title: "Release",
          properties: { tag: { type: "string", title: "Tag" } },
        },
      },
    });

    const group = container.querySelector(".meridian-schema-group");

    expect(group?.querySelector("legend")?.textContent).toBe("Release");
    expect(group?.contains(screen.getByLabelText("Tag"))).toBe(true);
  });

  it("draws a list with the control that adds an entry and none that removes one yet", () => {
    const container = renderForm({
      type: "object",
      properties: { reviewers: { type: "array", title: "Reviewers", items: { type: "string" } } },
    });

    expect(container.querySelector(".meridian-schema-list__legend")?.textContent).toContain(
      "Reviewers",
    );
    expect(screen.getByRole("button", { name: "Add an entry" })).toBeDefined();
    expect(container.querySelectorAll(".meridian-schema-list__item")).toHaveLength(0);
  });

  it("names each repeated control by its collection and the position it sits at", () => {
    const container = renderForm({
      type: "object",
      properties: { reviewers: { type: "array", title: "Reviewers", items: { type: "string" } } },
    });
    addListEntry();
    addListEntry();

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
    addListEntry();

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
    addListEntry();

    const dottedControl = screen.getByLabelText("A member named like a position");
    const entryControl = container.querySelector(".meridian-schema-list__item input");
    const entryDescribedBy = entryControl?.getAttribute("aria-describedby") ?? "";

    expect(document.getElementById(entryDescribedBy)?.textContent ?? "").not.toBe("");
    expect(dottedControl.getAttribute("aria-describedby")).toBeNull();
    expect(container.querySelectorAll(".meridian-schema-field__issues")).toHaveLength(1);
  });

  it("opens the raw editor for a schema outside the drawn set, and never a refusal", () => {
    const container = renderForm({
      type: "object",
      properties: { rows: { type: "array", items: { type: "object", properties: {} } } },
    });

    expect(container.querySelector(".meridian-schema-raw__editor")?.tagName).toBe("TEXTAREA");
    expect(container.querySelector(".meridian-schema-raw__reason")?.textContent).toContain("rows");
    // Nothing on this surface reports a refusal: the console's refusal shapes all carry
    // this class, and the whole point of the fallback is that none of them is reached.
    expect(container.querySelector(".meridian-refusal")).toBeNull();
  });

  it("says the schema itself could not be checked rather than showing a clean verdict", () => {
    const container = renderForm({
      type: "object",
      properties: { linked: { $ref: "#/definitions/missing" } },
    });

    expect(container.querySelector(".meridian-schema-raw__uncheckable")?.textContent).toContain(
      "only the JSON itself is checked",
    );
  });
});
