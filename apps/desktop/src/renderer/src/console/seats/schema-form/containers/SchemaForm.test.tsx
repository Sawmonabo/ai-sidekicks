// WHICH CONTROL A MEMBER SHAPE DRAWS, AND WHAT THAT CONTROL PUTS IN THE ANSWER.
//
// One of three suites over the drawn form, split when the single file reached the size at
// which `apps/desktop/AGENTS.md` §Module shape says it is doing two jobs. The clusters are
// the ones the cases already formed: this file owns the leaf controls and the values they
// compose, `SchemaForm.groups.test.tsx` owns the group fieldset, and
// `SchemaForm.findings.test.tsx` owns where a description and a finding are attached. The
// collection surface is `SchemaFieldList.test.tsx`; the arm that draws no controls at all
// is `SchemaJsonEditor.test.tsx`.
//
// Driven through the real hook rather than a hand-built state, because the two are one
// surface: a test that fed the component a fabricated plan would pass with the mapper
// deleted. Which is also why the presence cases below read the COMPOSED ANSWER: whether a
// member is in it is the half a rendered control cannot show.

import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { composedAnswer, renderForm } from "./SchemaFormHost.test-support.js";

afterEach(cleanup);

describe("the control a member shape draws", () => {
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
});

describe("the value a control puts in the answer", () => {
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
});
