// A nested object as a fieldset: what it draws, what it says about itself, and what it opens
// holding. Seed cases read the composed answer, since what a group opens holding is a claim
// about the answer. Sibling suites: `SchemaForm.test.ts` (leaf controls) and
// `SchemaForm.findings.test.ts` (where descriptions and findings attach).

import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  composedAnswer,
  renderForm,
  reportedIssueTexts,
} from "./SchemaFormWithReadout.test-support.js";

afterEach(cleanup);

describe("the fieldset a group draws", () => {
  it("draws a group as a named fieldset holding its own members", async () => {
    // Unanswered, an optional section draws its name and activation control and no members:
    // a control under a section nobody is answering would reach nothing.
    const container = await renderForm({
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

  it("says a group is required on its own legend, at the same depths a control says it", async () => {
    // A group's requiredness must read like a scalar's and a list's over a schema that
    // demands the whole group.
    const container = await renderForm({
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
    // One level in: a required member still says so, and an optional one does not.
    expect(
      requiredGroup?.querySelector(".meridian-schema-field .meridian-schema-field__required")
        ?.textContent,
    ).toContain("required");
    expect(
      optionalGroup?.querySelector(".meridian-schema-field .meridian-schema-field__required"),
    ).toBeNull();
  });

  it("opens a required group whose members are all optional at the empty object it accepts", async () => {
    // `{ release: {} }` is what this schema accepts and the form opens holding it; opening at
    // `{}` would put "must have required property" on the fieldset.
    const container = await renderForm({
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
