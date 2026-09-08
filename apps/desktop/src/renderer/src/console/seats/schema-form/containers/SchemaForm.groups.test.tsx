// A NESTED OBJECT AS A FIELDSET: what it draws, what it says about itself, and what it
// opens holding.
//
// One of three suites over the drawn form — `SchemaForm.test.tsx` states the split and
// owns the leaf controls; `SchemaForm.findings.test.tsx` owns where a description and a
// finding are attached. A group is the one member shape whose CHROME carries the same
// three claims a leaf control's does — a name, a requiredness, and a control that says
// whether an optional one is being answered — over a member that holds other members, so
// the cases are about the fieldset rather than about anything inside it.
//
// Driven through the real hook for the same reason the sibling suites are, and the seed
// cases read the COMPOSED ANSWER because what a group opens holding is a claim about the
// answer and not about the markup.

import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { composedAnswer, renderForm, reportedIssueTexts } from "./SchemaFormHost.test-support.js";

afterEach(cleanup);

describe("the fieldset a group draws", () => {
  it("draws a group as a named fieldset holding its own members", () => {
    // The same claim as before the draft tree, reached through the control that now says
    // whether an OPTIONAL section is being answered: unanswered, it draws its name and
    // that control and no members, because a control under a section nobody is answering
    // would be a control whose value reaches nothing.
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

    expect(group?.querySelector("legend")?.textContent).toContain("Release");
    expect(screen.queryByLabelText("Tag")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Answer this section" }));

    expect(group?.contains(screen.getByLabelText("Tag"))).toBe(true);
    expect(composedAnswer(container)).toEqual({ release: {} });

    fireEvent.click(screen.getByRole("button", { name: "Leave unanswered" }));

    expect(composedAnswer(container)).toEqual({});
  });

  it("says a group is required on its own legend, at the same depths a control says it", () => {
    // A group is a member like any other, and the requiredness a scalar and a list both
    // carry visibly was read for it and then dropped: the fieldset read optional beside
    // controls that read required, over a schema that demands the whole group.
    const container = renderForm({
      type: "object",
      properties: {
        release: {
          type: "object",
          title: "Release",
          properties: { tag: { type: "string", title: "Tag" } },
          required: ["tag"],
        },
        draft: {
          type: "object",
          title: "Draft",
          properties: { note: { type: "string", title: "Note" } },
        },
      },
      required: ["release"],
    });
    const [requiredGroup, optionalGroup] = [
      ...container.querySelectorAll(".meridian-schema-group"),
    ];

    expect(requiredGroup?.querySelector("legend")?.textContent).toContain("required");
    expect(optionalGroup?.querySelector("legend")?.textContent).not.toContain("required");
    // One level in, through the same primitive: a required member of a group still says
    // so, and an optional one still does not.
    expect(
      requiredGroup?.querySelector(".meridian-schema-field .meridian-schema-field__required")
        ?.textContent,
    ).toContain("required");
    expect(
      optionalGroup?.querySelector(".meridian-schema-field .meridian-schema-field__required"),
    ).toBeNull();
  });

  it("opens a required group whose members are all optional at the empty object it accepts", () => {
    // The finding the group-addressed case next door used to be written over. `{ release:
    // {} }` is what this schema accepts, and the form now opens holding it: before, the
    // answer held `{}`, the fieldset carried "must have required property", and the only
    // way to reach the valid state was to type into `tag` and clear it again — which wrote
    // `{ tag: "" }` and left the form invalid for a different reason.
    const container = renderForm({
      type: "object",
      properties: {
        release: {
          type: "object",
          title: "Release",
          properties: { tag: { type: "string", title: "Tag", minLength: 1 } },
        },
      },
      required: ["release"],
    });

    expect(composedAnswer(container)).toEqual({ release: {} });
    expect(reportedIssueTexts(container)).toEqual([]);
  });
});
