// What a numeric control lets THROUGH, which its rendering cannot show.
//
// The control sits inside a validating `<form>`, so its `step` is not an affordance: a
// value the platform reads as a step mismatch never reaches the submit handler, and a
// step the schema did not express refuses answers the verdict would have accepted. Each
// case here reads the step the control took from the descriptor the mapper drew — never a
// hand-built descriptor, since half of every case is that the mapper carried the fact.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SchemaNumberField } from "./SchemaNumberField.js";
import { planSchemaForm, type SchemaFieldDescriptor } from "../schema-fields.js";

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
