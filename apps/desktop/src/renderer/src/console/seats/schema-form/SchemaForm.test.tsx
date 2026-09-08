// The DRAWN form as a person meets it: six controls from six member shapes, a group, and
// where each of the schema's findings lands. The collection surface is
// `SchemaFieldList.test.tsx`; the arm that draws no controls at all is
// `SchemaJsonEditor.test.tsx`.
//
// Driven through the real hook rather than a hand-built state, because the two are one
// surface: a test that fed the component a fabricated plan would pass with the mapper
// deleted. Which is also why the presence cases below read the COMPOSED ANSWER: whether a
// member is in it is the half a rendered control cannot show.

import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  composedAnswer,
  renderedIssueTexts,
  renderForm,
  reportedIssueTexts,
  rootIssuesElement,
} from "./SchemaFormHost.test-support.js";

afterEach(cleanup);

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
      // The box is the control a boolean draws through where the answer must hold a value
      // for it. An OPTIONAL one is drawn as a three-state choice instead, which is the
      // case below rather than a seventh kind.
      required: ["approved"],
    });

    expect(screen.getByLabelText("Title").tagName).toBe("INPUT");
    expect(screen.getByLabelText("Notes").tagName).toBe("TEXTAREA");
    expect(screen.getByLabelText("Count")).toHaveProperty("type", "number");
    // Matched loosely because this one is required, and a required member's label carries
    // the mark beside its name.
    expect(screen.getByLabelText(/Approved/u)).toHaveProperty("type", "checkbox");
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

  it("draws an optional yes-or-no as a three-state choice, so it can be left unanswered", () => {
    const container = renderForm({
      type: "object",
      properties: { notify: { type: "boolean", title: "Notify" } },
    });
    const notify = screen.getByLabelText("Notify");

    expect(notify.tagName).toBe("SELECT");
    expect([...notify.querySelectorAll("option")].map((option) => option.textContent)).toEqual([
      "Not answered",
      "Yes",
      "No",
    ]);
    // Unanswered is ABSENT and never a member worth some other value, which is the whole
    // reading a box could not offer.
    expect(composedAnswer(container)).toEqual({});
  });

  it("writes the boolean a person picked rather than the word the option showed", () => {
    const container = renderForm({
      type: "object",
      properties: { notify: { type: "boolean", title: "Notify" } },
    });
    const notify = screen.getByLabelText("Notify");
    const yes = [...notify.querySelectorAll("option")].find(
      (option) => option.textContent === "Yes",
    );

    fireEvent.change(notify, { target: { value: yes?.value } });

    expect(composedAnswer(container)).toEqual({ notify: true });
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
    const describedBy = (group?.getAttribute("aria-describedby") ?? "").split(" ");

    expect(describedBy).toHaveLength(1);
    expect(document.getElementById(describedBy[0] ?? "")?.textContent).toBe("What ships.");
  });

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

  it("opens a required group whose members are all optional at the empty object it accepts", () => {
    // The finding the case above used to be written over. `{ release: {} }` is what this
    // schema accepts, and the form now opens holding it: before, the answer held `{}`, the
    // fieldset carried "must have required property", and the only way to reach the valid
    // state was to type into `tag` and clear it again — which wrote `{ tag: "" }` and left
    // the form invalid for a different reason.
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

  it("takes an optional text member back out of the answer when its box is cleared", () => {
    // The untouched box and the cleared one look identical, so the answer has to say the
    // same thing about both. Writing `""` for the cleared one made the form reachable into
    // a state it could not reach back out of, with no UI action that restores the absence
    // it opened with.
    const container = renderForm({
      type: "object",
      properties: { note: { type: "string", title: "Note" } },
    });
    const note = screen.getByLabelText("Note");

    fireEvent.change(note, { target: { value: "looks good" } });
    expect(composedAnswer(container)).toEqual({ note: "looks good" });

    fireEvent.change(note, { target: { value: "" } });

    expect(composedAnswer(container)).toEqual({});
  });

  it("keeps a figure the numeric control cannot carry out of the answer altogether", () => {
    // End to end, because the divergence was between two layers: the control turned
    // `1e309` into `Infinity`, the box went blank because it cannot render one, and the
    // composed answer serialized it to `null` — three different readings of one keystroke.
    const container = renderForm({
      type: "object",
      properties: { ratio: { type: "number", title: "Ratio" } },
    });

    fireEvent.change(screen.getByLabelText("Ratio"), { target: { value: "1e309" } });

    expect(composedAnswer(container)).toEqual({});
    expect(screen.getByLabelText("Ratio")).toHaveProperty("value", "1e309");
  });

  it("negative control: an unchecked box is still the answer `false` and never an absence", () => {
    // The one control with no unanswered state, and the reason the rule is about what a
    // control can DISPLAY: unchecked says no, so the member stays in the answer where a
    // cleared text box leaves it.
    const container = renderForm({
      type: "object",
      properties: { approved: { type: "boolean", title: "Approved" } },
      required: ["approved"],
    });
    const approved = screen.getByLabelText(/Approved/u);

    fireEvent.click(approved);
    fireEvent.click(approved);

    expect(composedAnswer(container)).toEqual({ approved: false });
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
