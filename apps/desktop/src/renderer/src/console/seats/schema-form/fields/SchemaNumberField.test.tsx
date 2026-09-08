// What a numeric control lets THROUGH, which its rendering cannot show.
//
// The control sits inside a validating `<form>`, so its `step` is not an affordance: a
// value the platform reads as a step mismatch never reaches the submit handler, and a
// step the schema did not express refuses answers the verdict would have accepted. Each
// case here reads the step the control took from the descriptor the mapper drew — never a
// hand-built descriptor, since half of every case is that the mapper carried the fact.
//
// AND WHAT IT LETS THROUGH INCLUDES WHAT IT WILL NOT. A figure outside JavaScript's finite
// range is syntactically a number, so the platform hands it over as typed and `Number`
// turns it into `Infinity` — a value no numeric control can render and no JSON document
// can carry. The cases below read BOTH halves of that, the value reported to the caller
// and the text the box is left showing, because a control that stores the wrong value and
// one that stores the right one look identical.

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SchemaNumberField } from "./SchemaNumberField.js";
import { answeredScalar, unansweredScalar } from "../schema-draft.js";
import { type SchemaFieldDescriptor } from "../schema-fields.js";
import { planSchemaForm } from "../schema-form-plan.js";

afterEach(cleanup);

/** The descriptor the mapper draws for one numeric member declared as given. */
function numericFieldOf(member: Readonly<Record<string, unknown>>): SchemaFieldDescriptor {
  const plan = planSchemaForm({ type: "object", properties: { ratio: member } });
  const entry = plan.shape === "fields" ? plan.entries[0] : undefined;
  if (entry?.form !== "field" || entry.field.kind !== "number") {
    throw new Error("the mapper did not draw this member as a numeric control");
  }
  return entry.field;
}

/** The step the mounted control took for a member declared as given. */
function stepTakenFor(member: Readonly<Record<string, unknown>>): string | null {
  const { container } = render(
    <SchemaNumberField
      field={numericFieldOf(member)}
      value={undefined}
      unreadableText=""
      onChange={vi.fn()}
      controlId="ratio-control"
      describedById={undefined}
    />,
  );
  const input = container.querySelector("input");
  if (input === null) {
    throw new Error("the numeric control drew no input");
  }
  return input.getAttribute("step");
}

/**
 * Mount the control over one member schema, reporting what it writes and what it shows.
 *
 * The unreadable text is a PROP now rather than component state, so a case that asserts
 * what the box shows for one hands it the same way the form does — from the draft node
 * the member holds.
 */
function renderNumeric(
  member: Readonly<Record<string, unknown>>,
  value: unknown,
  unreadableText = "",
): {
  readonly input: HTMLInputElement;
  readonly onChange: ReturnType<typeof vi.fn>;
} {
  const onChange = vi.fn();
  const { container } = render(
    <SchemaNumberField
      field={numericFieldOf(member)}
      value={value}
      unreadableText={unreadableText}
      onChange={onChange}
      controlId="ratio-control"
      describedById={undefined}
    />,
  );
  const input = container.querySelector("input");
  if (input === null) {
    throw new Error("the numeric control drew no input");
  }
  return { input, onChange };
}

describe("the numeric control's step", () => {
  it("is unrestricted for a number the schema left open, so a fraction is sendable", () => {
    expect(stepTakenFor({ type: "number" })).toBe("any");
  });

  it("is one for an integer, which is the validator's own rule arriving earlier", () => {
    expect(stepTakenFor({ type: "integer" })).toBe("1");
  });

  it("is the schema's multipleOf where it declared one", () => {
    expect(stepTakenFor({ type: "number", multipleOf: 0.25 })).toBe("0.25");
  });

  it("negative control: a multipleOf the schema could not mean leaves the type's step", () => {
    expect(stepTakenFor({ type: "number", multipleOf: 0 })).toBe("any");
    expect(stepTakenFor({ type: "integer", multipleOf: -2 })).toBe("1");
  });
});

describe("a figure the control cannot carry", () => {
  it("writes no member for a figure outside the finite range, and keeps showing it", () => {
    // `Number("1e309")` is `Infinity`: not JSON, unrenderable by this control, and turned
    // into `null` by serialization. Stored, the box went BLANK while the answer carried a
    // value nobody had seen and no control could clear — what is on the screen and what a
    // press would send disagreeing in the one way this subtree exists to prevent.
    const { input, onChange } = renderNumeric({ type: "number" }, undefined);

    fireEvent.change(input, { target: { value: "1e309" } });

    // An UNANSWERED node carrying the text, so the member holds nothing and the text has
    // a home on the member rather than in this component — which is what keeps it with
    // its own list entry when the rows around it shift.
    expect(onChange).toHaveBeenCalledWith(unansweredScalar("1e309"));
    expect(onChange).not.toHaveBeenCalledWith(answeredScalar(Infinity));
    // The other half, and the reason absence is honest here: the text is shown back, so
    // the person can see what the form would not take.
    expect(renderNumeric({ type: "number" }, undefined, "1e309").input.value).toBe("1e309");
    expect(
      renderNumeric({ type: "number" }, undefined, "1e309").input.getAttribute("aria-invalid"),
    ).toBe("true");
  });

  it("negative control: a finite figure is written and the control reports nothing wrong", () => {
    const { input, onChange } = renderNumeric({ type: "number" }, undefined);

    fireEvent.change(input, { target: { value: "1e30" } });

    expect(onChange).toHaveBeenCalledWith(answeredScalar(1e30));
    expect(input.getAttribute("aria-invalid")).toBeNull();
  });

  it("returns to an unanswered member when the box is cleared", () => {
    // Held at a figure the answer already carries, so clearing is a real edit rather than
    // a no-op on a box that was empty to begin with.
    const { input, onChange } = renderNumeric({ type: "number" }, 5);

    expect(input.value).toBe("5");
    fireEvent.change(input, { target: { value: "" } });

    expect(onChange).toHaveBeenCalledWith(unansweredScalar(""));
    expect(input.getAttribute("aria-invalid")).toBeNull();
  });
});
