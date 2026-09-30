// The other arm: a schema this form cannot draw controls for, answered as JSON. Covers which
// schemas reach it, what it says about a schema nothing could check, and how its one control
// carries the two verdicts. Driven through the real mount, since half of every case is that
// the mapper sent the schema to the editor.

import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { renderForm } from "./SchemaFormWithReadout.test-support.js";

afterEach(cleanup);

describe("the raw JSON arm of a schema-derived form", () => {
  it("opens the raw editor for a schema outside the drawn set, and never a refusal", async () => {
    const container = await renderForm({
      type: "object",
      properties: { rows: { type: "array", items: { type: "object", properties: {} } } },
    });

    expect(container.querySelector(".meridian-schema-raw__editor")?.tagName).toBe("TEXTAREA");
    expect(container.querySelector(".meridian-schema-raw__reason")?.textContent).toContain("rows");
    // The fallback is not a refusal: none of the console's refusal shapes is reached.
    expect(container.querySelector(".meridian-refusal")).toBeNull();
  });

  it("attaches the raw editor's own findings to the editor, as a drawn control does", async () => {
    // Focus stays in the textarea while typing, so the verdict must reach a reader through
    // `aria-describedby`, the primitive the drawn fields use.
    const container = await renderForm({
      type: "object",
      properties: { rows: { type: "array", items: { type: "object", properties: {} } } },
      required: ["rows"],
    });
    const editor = container.querySelector(".meridian-schema-raw__editor");
    const describedBy = editor?.getAttribute("aria-describedby") ?? "";

    expect(editor?.getAttribute("aria-invalid")).toBe("true");
    expect(describedBy).not.toBe("");
    expect(document.getElementById(describedBy)?.textContent ?? "").not.toBe("");
    // Through the one issues primitive, so the sentence matches what a drawn field shows.
    expect(
      container.querySelector(".meridian-schema-raw .meridian-schema-field__issues"),
    ).not.toBeNull();
  });

  it("negative control: a raw document the schema accepts carries neither reading", async () => {
    const container = await renderForm({
      type: "object",
      properties: { rows: { type: "array", items: { type: "object", properties: {} } } },
      required: ["rows"],
    });
    const editor = container.querySelector(".meridian-schema-raw__editor");
    if (editor === null) {
      throw new Error("the raw arm drew no editor");
    }

    fireEvent.change(editor, { target: { value: '{"rows": []}' } });

    expect(editor.getAttribute("aria-invalid")).toBeNull();
    expect(editor.getAttribute("aria-describedby")).toBeNull();
  });

  it("says the schema itself could not be checked rather than showing a clean verdict", async () => {
    const container = await renderForm({
      type: "object",
      properties: { linked: { $ref: "#/definitions/missing" } },
    });

    expect(container.querySelector(".meridian-schema-raw__uncheckable")?.textContent).toContain(
      "only the JSON itself is checked",
    );
  });

  it("answers a schema that compiled nowhere as JSON rather than in controls it cannot check", async () => {
    const container = await renderForm({
      type: "object",
      properties: { title: { type: "string", title: "Title" } },
      // Drawable members and an unreadable root construct: the mapper accepts, the schema
      // reader does not, so the arm must follow the validator.
      if: { properties: { title: { const: "urgent" } } },
      then: { required: ["title"] },
    });

    expect(container.querySelector(".meridian-schema-raw__editor")?.tagName).toBe("TEXTAREA");
    expect(container.querySelector(".meridian-schema-raw__uncheckable")?.textContent).toContain(
      "only the JSON itself is checked",
    );
    expect(screen.queryByLabelText("Title")).toBeNull();
  });
});
