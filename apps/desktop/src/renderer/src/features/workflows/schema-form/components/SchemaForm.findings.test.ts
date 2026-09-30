// Where a description and a finding are attached, and at what depth each finding lands: the
// `aria-describedby` every container and control composes (description ahead of findings).
// Assertions read the attribute and resolve the ids it names, since a reader never sees the
// layout. The depth cases read the report beside the DOM. Sibling suites: `SchemaForm.test.ts`
// (leaf controls) and `SchemaForm.groups.test.ts` (the group fieldset).

import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  listFieldset,
  renderForm,
  renderedIssueTexts,
  reportedIssueTexts,
  rootIssuesElement,
} from "./SchemaFormWithReadout.test-support.js";

afterEach(cleanup);

/** The ids one element's `aria-describedby` names, in order. */
function describedByIds(described: Element | null): readonly string[] {
  const attribute = described?.getAttribute("aria-describedby") ?? "";
  return attribute === "" ? [] : attribute.split(" ");
}

describe("what a member's description is attached to", () => {
  it("attaches a member's description to its control rather than leaving it beside one", async () => {
    await renderForm({
      type: "object",
      properties: { title: { type: "string", title: "Title", description: "One line." } },
    });

    const [descriptionId] = describedByIds(screen.getByLabelText("Title"));

    expect(descriptionId).toBeDefined();
    expect(document.getElementById(descriptionId ?? "")?.textContent).toBe("One line.");
  });

  it("names a group's description in the fieldset's description, ahead of any finding", async () => {
    // The group's paragraph must carry an id the fieldset names, as the collection's does.
    const container = await renderForm({
      type: "object",
      properties: {
        release: {
          type: "object",
          title: "Release",
          description: "What ships.",
          properties: { tag: { type: "string", title: "Tag" } },
        },
      },
    });
    const group = container.querySelector(".meridian-schema-group");
    const describedBy = describedByIds(group);

    expect(describedBy).toHaveLength(1);
    expect(document.getElementById(describedBy[0] ?? "")?.textContent).toBe("What ships.");
  });

  it("names a collection's description ahead of its finding when the fieldset carries both", async () => {
    // The order, on the one shape that carries both at once: `aria-describedby` is announced
    // in listed order, so description-then-findings differs from findings-then-description.
    // A required collection is answered from the mount, so `minItems` fails with no interaction.
    const container = await renderForm({
      type: "object",
      properties: {
        reviewers: {
          type: "array",
          title: "Reviewers",
          description: "Who signs off.",
          items: { type: "string", title: "Reviewer" },
          minItems: 1,
        },
      },
      required: ["reviewers"],
    });
    const fieldset = listFieldset(container);
    const findings = fieldset.querySelector(":scope > .meridian-schema-field__issues");
    const description = fieldset.querySelector(":scope > .meridian-schema-field__description");
    const describedBy = describedByIds(fieldset);

    expect(findings?.textContent ?? "").not.toBe("");
    expect(description?.textContent).toBe("Who signs off.");
    expect(describedBy).toEqual([description?.id, findings?.id]);
    // Negative control: the set is right either way round, so membership alone would pass.
    expect(describedBy).not.toEqual([findings?.id, description?.id]);
  });
});

describe("where a finding lands", () => {
  it("renders the schema's own findings against the control they are about", async () => {
    const container = await renderForm({
      type: "object",
      properties: { count: { type: "number", title: "Count" } },
      required: ["count"],
    });

    const issues = container.querySelector(".meridian-schema-field__issues");

    expect(issues?.textContent ?? "").not.toBe("");
  });

  it("renders a finding addressed to a group on the group's own fieldset", async () => {
    // A constraint on the object itself. A required group opens at the `{}` its legend stands
    // over, so the missing-group finding is unreachable; what the schema says about the object
    // arrives at the group's own path with no child to hang on, so the fieldset draws it.
    const container = await renderForm({
      type: "object",
      properties: {
        release: {
          type: "object",
          title: "Release",
          properties: { tag: { type: "string", title: "Tag" } },
          const: { tag: "v1" },
        },
      },
      required: ["release"],
    });

    const groupIssues = container.querySelector(
      ".meridian-schema-group > .meridian-schema-field__issues",
    );

    expect(groupIssues?.textContent ?? "").not.toBe("");
    expect(
      container.querySelector(".meridian-schema-group")?.getAttribute("aria-describedby"),
    ).toBe(groupIssues?.id);
  });

  it("renders a finding addressed to the whole answer, which no control could be about", async () => {
    const container = await renderForm({
      type: "object",
      properties: {
        approver: { type: "string", title: "Approver" },
        deputy: { type: "string", title: "Deputy" },
      },
      // Both members are optional, so the only thing wrong is the root constraint, reported at
      // the empty path, which this form draws no control for.
      oneOf: [{ required: ["approver"] }, { required: ["deputy"] }],
    });

    const rootIssues = rootIssuesElement(container);

    expect(rootIssues?.textContent ?? "").not.toBe("");
    expect(container.querySelector(".meridian-schema-form")?.getAttribute("aria-describedby")).toBe(
      rootIssues?.id,
    );
  });

  it("draws every finding the report carries, at whatever depth the schema addressed it", async () => {
    // Three constraints fail at three depths; the report and the drawn sentences must be the
    // same multiset: every finding reaches a person and none is drawn twice.
    const container = await renderForm({
      type: "object",
      properties: {
        approver: { type: "string", title: "Approver", minLength: 3, default: "ab" },
        // Drawn because the constraint can require it: a member a root combinator names but
        // `properties` does not declare sends the whole schema to the raw editor.
        deputy: { type: "string", title: "Deputy" },
        scope: {
          type: "object",
          title: "Scope",
          properties: { note: { type: "string", title: "Note" } },
          required: ["note"],
        },
      },
      required: ["scope"],
      oneOf: [{ required: ["approver", "scope"] }, { required: ["deputy"] }],
    });

    const reported = [...reportedIssueTexts(container)].sort();

    expect(reported).toHaveLength(3);
    expect([...renderedIssueTexts(container)].sort()).toEqual(reported);
    // Three separate blocks: one list carrying all three would pass the multiset above while
    // telling a person nothing about where to go.
    expect(container.querySelectorAll(".meridian-schema-field__issues")).toHaveLength(3);
    expect(rootIssuesElement(container)?.textContent ?? "").not.toBe("");
  });
});
