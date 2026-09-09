// WHERE A DESCRIPTION AND A FINDING ARE ATTACHED, AND AT WHAT DEPTH EACH FINDING LANDS.
//
// One of three suites over the drawn form — `SchemaForm.test.tsx` states the split and
// owns the leaf controls, `SchemaForm.groups.test.tsx` owns the group fieldset. What this
// file owns is the one attribute every container and every control composes the same way:
// `aria-describedby`, naming the member's own description ahead of the member's own
// findings. A case here is about a reader who never sees the form, so the assertions read
// the ATTRIBUTE and resolve the ids it names rather than looking at what is drawn near
// what.
//
// Driven through the real hook for the sibling suites' reason, and the depth cases read
// the report beside the DOM because "every finding reached a person" is a claim about the
// two together.

import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  listFieldset,
  renderForm,
  renderedIssueTexts,
  reportedIssueTexts,
  rootIssuesElement,
} from "./SchemaFormHost.test-support.js";

afterEach(cleanup);

/** The ids one element's `aria-describedby` names, in the order it names them. */
function describedByIds(described: Element | null): readonly string[] {
  const attribute = described?.getAttribute("aria-describedby") ?? "";
  return attribute === "" ? [] : attribute.split(" ");
}

describe("what a member's description is attached to", () => {
  it("attaches a member's description to its control rather than leaving it beside one", () => {
    renderForm({
      type: "object",
      properties: { title: { type: "string", title: "Title", description: "One line." } },
    });

    const [descriptionId] = describedByIds(screen.getByLabelText("Title"));

    expect(descriptionId).toBeDefined();
    expect(document.getElementById(descriptionId ?? "")?.textContent).toBe("One line.");
  });

  it("names a group's description in the fieldset's description, ahead of any finding", () => {
    // The same gap the collection's fieldset carried: the paragraph was drawn, carried no
    // id, and the fieldset named only findings — so a reader moving among the section's
    // own controls heard its name and never the author's instructions.
    const group = renderForm({
      type: "object",
      properties: {
        release: {
          type: "object",
          title: "Release",
          description: "What ships.",
          properties: { tag: { type: "string", title: "Tag" } },
        },
      },
    }).querySelector(".meridian-schema-group");
    const describedBy = describedByIds(group);

    expect(describedBy).toHaveLength(1);
    expect(document.getElementById(describedBy[0] ?? "")?.textContent).toBe("What ships.");
  });

  it("names a collection's description ahead of its finding when the fieldset carries both", () => {
    // THE ORDER, ON THE ONE SHAPE THAT CAN CARRY BOTH AT ONCE. The group case above
    // establishes that a description is named at all, over a fieldset with nothing wrong
    // with it; every other case here has a finding and no description. Neither pins the
    // SEQUENCE, and the sequence is what a reader hears: `aria-describedby` is announced in
    // the order the attribute lists, so instructions-then-verdict and verdict-then-
    // instructions are two different surfaces built from the same two elements, and the
    // one `SchemaFieldList.tsx` composes is description first.
    //
    // A required collection is answered from the mount, so `minItems` is unsatisfied the
    // moment the form opens and the fieldset carries a finding about its own path with no
    // interaction at all.
    const container = renderForm({
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
    // The negative control on the same two elements: the set is right either way round, so
    // a case that only asserted membership would pass over the surface that reads the
    // verdict out before the instructions it is a verdict on.
    expect(describedBy).not.toEqual([findings?.id, description?.id]);
  });
});

describe("where a finding lands", () => {
  it("renders the schema's own findings against the control they are about", () => {
    const container = renderForm({
      type: "object",
      properties: { count: { type: "number", title: "Count" } },
      required: ["count"],
    });

    const issues = container.querySelector(".meridian-schema-field__issues");

    expect(issues?.textContent ?? "").not.toBe("");
  });

  it("renders a finding addressed to a group on the group's own fieldset", () => {
    // A CONSTRAINT ON THE OBJECT ITSELF, which is what a group-addressed finding now is.
    // "This required group is missing" used to be the case here, and it is not reachable
    // any more: a required group opens at the `{}` its legend stands over, which is the
    // seed's whole point — that finding named a member the form offered no control to
    // create. What the schema says about the OBJECT still arrives at the group's own path
    // and has no child to be drawn against, so the fieldset is where it goes.
    const container = renderForm({
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

  it("renders a finding addressed to the whole answer, which no control could be about", () => {
    const container = renderForm({
      type: "object",
      properties: {
        approver: { type: "string", title: "Approver" },
        deputy: { type: "string", title: "Deputy" },
      },
      // Both members are optional, so every control on this form reads clean and the ONLY
      // thing wrong with the answer is the root constraint — reported at the empty path,
      // which is the one member this form draws no control for.
      oneOf: [{ required: ["approver"] }, { required: ["deputy"] }],
    });

    const rootIssues = rootIssuesElement(container);

    expect(rootIssues?.textContent ?? "").not.toBe("");
    expect(container.querySelector(".meridian-schema-form")?.getAttribute("aria-describedby")).toBe(
      rootIssues?.id,
    );
  });

  it("draws every finding the report carries, at whatever depth the schema addressed it", () => {
    // Three constraints failing at three depths at once: the root's `oneOf`, the group's
    // own requiredness, and one leaf's length. The property is that the report and the
    // drawn sentences are the SAME multiset — every finding reaches a person, and none is
    // drawn twice by two blocks both claiming it.
    const container = renderForm({
      type: "object",
      properties: {
        approver: { type: "string", title: "Approver", minLength: 3, default: "ab" },
        // Drawn because the constraint below can require it: a member a root combinator
        // names and `properties` does not declare sends the whole schema to the raw
        // editor, which would have made this a case about a form that is never drawn.
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
    // Three findings drawn by three separate blocks, which is what "each is addressed to
    // what it is about" means here: one list carrying all three would satisfy the multiset
    // above while telling a person nothing about where to go.
    expect(container.querySelectorAll(".meridian-schema-field__issues")).toHaveLength(3);
    expect(rootIssuesElement(container)?.textContent ?? "").not.toBe("");
  });
});
