// What a leaf control puts in the answer: the value a person picked, never the word the option
// showed or a figure the control cannot carry. Driven through the real hook, since a fabricated
// plan would pass with the mapper deleted; the cases read the composed answer, which a rendered
// control cannot show.

import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { composedAnswer, renderForm } from "./SchemaFormWithReadout.test-support.js";

afterEach(cleanup);

describe("the value a control puts in the answer", () => {
  it(
    "submits an enumeration member the schema spells empty rather " +
      "than reading it as no answer",
    async () => {
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
    },
  );

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

  it("keeps a figure the numeric control cannot carry out of the answer altogether", async () => {
    // Admitted, `1e309` reads as `Infinity`, the box goes blank, and the answer serializes it
    // to `null`: three readings of one keystroke.
    const container = await renderForm({
      type: "object",
      properties: { ratio: { type: "number", title: "Ratio" } },
    });

    fireEvent.change(screen.getByLabelText("Ratio"), { target: { value: "1e309" } });

    expect(composedAnswer(container)).toEqual({});
    expect(screen.getByLabelText("Ratio")).toHaveProperty("value", "1e309");
  });
});
