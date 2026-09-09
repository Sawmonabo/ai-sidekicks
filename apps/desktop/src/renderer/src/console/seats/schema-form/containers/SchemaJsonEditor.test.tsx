// The OTHER arm: a schema this form cannot draw controls for, answered as JSON.
//
// SPLIT FROM `SchemaForm.test.tsx` because the two are different subjects and that file
// had stopped being one reading. It owns the drawn form — which control a member draws,
// where a finding addressed to a member, a group, or the whole answer is rendered. This
// one owns the arm that draws no controls at all: which schemas reach it, what it says
// about a schema nothing could check, and how the one control it does draw carries the
// two verdicts about the document typed into it.
//
// Driven through the same real mount, for that suite's reason: a case fed a fabricated
// plan would pass with the mapper deleted, and half of every case here is that the mapper
// sent this schema to the editor rather than drawing it.

import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { renderForm } from "./SchemaFormHost.test-support.js";

afterEach(cleanup);

describe("the raw JSON arm of a schema-derived form", () => {
  it("opens the raw editor for a schema outside the drawn set, and never a refusal", async () => {
    const container = await renderForm({
      type: "object",
      properties: { rows: { type: "array", items: { type: "object", properties: {} } } },
    });

    expect(container.querySelector(".meridian-schema-raw__editor")?.tagName).toBe("TEXTAREA");
    expect(container.querySelector(".meridian-schema-raw__reason")?.textContent).toContain("rows");
    // Nothing on this surface reports a refusal: the console's refusal shapes all carry
    // this class, and the whole point of the fallback is that none of them is reached.
    expect(container.querySelector(".meridian-refusal")).toBeNull();
  });

  it("attaches the raw editor's own findings to the editor, as a drawn control does", async () => {
    // Focus stays in the textarea while somebody types, so a reader whose document had
    // just become invalid was told neither that it was invalid nor what the schema said —
    // on the one arm where the whole answer is typed into a single control. Same primitive
    // and same attribute the drawn fields use, not a second mechanism beside them.
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
    // Through the one issues primitive, so the sentence a reader reaches here is the
    // sentence a drawn field would have shown them.
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
      // Drawable members and an unreadable ROOT construct: the mapper is happy, the
      // schema reader is not, and the arm that used to be chosen from the mapper alone
      // drew a control whose answer nothing could refuse.
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
