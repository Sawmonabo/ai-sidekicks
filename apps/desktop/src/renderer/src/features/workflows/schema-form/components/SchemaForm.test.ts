// Which control a member shape draws and what that control puts in the answer: the leaf
// controls and their values. Sibling suites: `SchemaForm.groups.test.ts`,
// `SchemaForm.findings.test.ts`, `SchemaFieldList.test.ts` and `SchemaJsonEditor.test.ts`.
// Driven through the real hook, since a fabricated plan would pass with the mapper deleted;
// presence cases read the composed answer, which a rendered control cannot show.

import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { composedAnswer, renderForm } from "./SchemaFormWithReadout.test-support.js";

afterEach(cleanup);

describe("the control a member shape draws", () => {
  it("draws one labeled control for each of the five kinds", async () => {
    await renderForm({
      type: "object",
      properties: {
        title: { type: "string", title: "Title" },
        notes: { type: "string", format: "long_text", title: "Notes" },
        count: { type: "integer", title: "Count" },
        approved: { type: "boolean", title: "Approved" },
        severity: { type: "string", enum: ["low", "high"], title: "Severity" },
      },
      // The box is drawn where the answer must hold a value; an optional boolean is drawn as
      // a three-state choice instead (the case below).
      required: ["approved"],
    });

    expect(screen.getByLabelText("Title").tagName).toBe("INPUT");
    expect(screen.getByLabelText("Notes").tagName).toBe("TEXTAREA");
    expect(screen.getByLabelText("Count")).toHaveProperty("type", "number");
    // Matched loosely: a required member's label carries the mark beside its name.
    expect(screen.getByLabelText(/Approved/u)).toHaveProperty("type", "checkbox");
    expect(screen.getByLabelText("Severity").tagName).toBe("SELECT");
  });

  it("offers the enumeration's members and one unanswered option that is not one of them", async () => {
    await renderForm({
      type: "object",
      properties: { severity: { type: "string", enum: ["low", "high"], title: "Severity" } },
    });

    const options = [...screen.getByLabelText("Severity").querySelectorAll("option")];

    expect(options.map((option) => option.textContent)).toEqual(["Not answered", "low", "high"]);
    // Members are offered under their positions, so the unanswered value is the one that is
    // not an index.
    expect(options.map((option) => option.value)).toEqual(["", "0", "1"]);
  });

  it("draws an optional yes-or-no as a three-state choice, so it can be left unanswered", async () => {
    const container = await renderForm({
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
    // Unanswered is absent, never a member worth some other value.
    expect(composedAnswer(container)).toEqual({});
  });

  it("says which members the schema requires without deciding whether they are answered", async () => {
    const container = await renderForm({
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
  it("submits an enumeration member the schema spells empty rather than reading it as no answer", async () => {
    const container = await renderForm({
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

  it("writes the boolean a person picked rather than the word the option showed", async () => {
    const container = await renderForm({
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

  it("takes an optional text member back out of the answer when its box is cleared", async () => {
    // The untouched box and the cleared one look identical, so the answer must say the same
    // about both; writing `""` left no UI action that restores the opening absence.
    const container = await renderForm({
      type: "object",
      properties: { note: { type: "string", title: "Note" } },
    });
    const note = screen.getByLabelText("Note");

    fireEvent.change(note, { target: { value: "looks good" } });
    expect(composedAnswer(container)).toEqual({ note: "looks good" });

    fireEvent.change(note, { target: { value: "" } });

    expect(composedAnswer(container)).toEqual({});
  });

  it("keeps a figure the numeric control cannot carry out of the answer altogether", async () => {
    // End to end: the control turned `1e309` into `Infinity`, the box went blank, and the
    // answer serialized it to `null` — three readings of one keystroke.
    const container = await renderForm({
      type: "object",
      properties: { ratio: { type: "number", title: "Ratio" } },
    });

    fireEvent.change(screen.getByLabelText("Ratio"), { target: { value: "1e309" } });

    expect(composedAnswer(container)).toEqual({});
    expect(screen.getByLabelText("Ratio")).toHaveProperty("value", "1e309");
  });

  it("negative control: an unchecked box is still the answer `false` and never an absence", async () => {
    // The one control with no unanswered state: unchecked says no, so the member stays in the
    // answer where a cleared text box leaves it.
    const container = await renderForm({
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
