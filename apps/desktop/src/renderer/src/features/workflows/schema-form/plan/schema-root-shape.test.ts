// Which roots this console can answer at all: each root a phase could write, asserted against
// whether an answer for it could reach the wire.

import { describe, expect, it } from "vitest";

import { planSchemaForm } from "./schema-form-plan.js";
import {
  SCHEMA_ROOT_NOT_NAMED_VALUES,
  schemaRootAsksOutsideNamedValues,
  schemaRootRefusal,
} from "./schema-root-shape.js";

describe("the human-phase schema root reading", () => {
  it("refuses every scalar and collection root, because no answer for one can be sent", () => {
    const refusedRoots = ["string", "number", "integer", "boolean", "array", "null"];

    expect(refusedRoots.filter((type) => schemaRootAsksOutsideNamedValues({ type }))).toEqual(
      refusedRoots,
    );
  });

  it("refuses a type UNION that names no object, which admits the same values", () => {
    // The array spelling declares the whole set the root admits, so `string` or `null` is as
    // unanswerable as a bare `string`.
    expect(schemaRootAsksOutsideNamedValues({ type: ["string", "null"] })).toBe(true);
    expect(schemaRootAsksOutsideNamedValues({ type: ["string", "object"] })).toBe(false);
  });

  it("admits the object root, which is the shape the submitted answer is", () => {
    expect(schemaRootAsksOutsideNamedValues({ type: "object", properties: {} })).toBe(false);
    expect(schemaRootRefusal({ type: "object" })).toBeUndefined();
  });

  it("admits a root that declares no type at all, which asked for nothing in particular", () => {
    // An absent or unreadable root says nothing about whether the answer may be an object.
    expect(schemaRootAsksOutsideNamedValues(undefined)).toBe(false);
    expect(schemaRootAsksOutsideNamedValues("not a schema at all")).toBe(false);
    expect(schemaRootAsksOutsideNamedValues({ properties: {} })).toBe(false);
  });

  it("carries the refusal code and one sentence naming the definition as the remedy", () => {
    const refusal = schemaRootRefusal({ type: "string" });

    expect(refusal?.code).toBe(SCHEMA_ROOT_NOT_NAMED_VALUES);
    expect(refusal?.detail).toContain("definition");
    // Never the schema's own words: `type` is author-written and this sentence is fixed.
    expect(refusal?.detail).not.toContain("string");
  });
});

describe("a root that closes the answer set without naming a type", () => {
  // None of these roots spells a `type`, so a type-only reading would admit every one.
  it("refuses an alternation no arm of which an object could satisfy", () => {
    const stringOrNumber = { oneOf: [{ type: "string" }, { type: "number" }] };

    expect(schemaRootAsksOutsideNamedValues(stringOrNumber)).toBe(true);
    expect(schemaRootRefusal(stringOrNumber)?.code).toBe(SCHEMA_ROOT_NOT_NAMED_VALUES);
    // Without the refusal the raw editor would be drawn and offered.
    expect(planSchemaForm(stringOrNumber).shape).toBe("raw");
  });

  it("admits an alternation one arm of which an object could satisfy", () => {
    expect(
      schemaRootAsksOutsideNamedValues({ oneOf: [{ type: "string" }, { type: "object" }] }),
    ).toBe(false);
    expect(
      schemaRootAsksOutsideNamedValues({ anyOf: [{ type: "object" }, { type: "array" }] }),
    ).toBe(false);
  });

  it("refuses a conjunction ANY arm of which an object could not satisfy", () => {
    // An answer has to satisfy every `allOf` arm, so one unanswerable arm closes the set.
    expect(
      schemaRootAsksOutsideNamedValues({ allOf: [{ type: "object" }, { type: "string" }] }),
    ).toBe(true);
    expect(
      schemaRootAsksOutsideNamedValues({ allOf: [{ type: "object" }, { properties: {} }] }),
    ).toBe(false);
  });

  it("refuses an enumeration no member of which is an object, and admits one that has one", () => {
    expect(schemaRootAsksOutsideNamedValues({ enum: [1, 2] })).toBe(true);
    expect(schemaRootAsksOutsideNamedValues({ enum: [1, { answer: true }] })).toBe(false);
  });

  it("reads a constant as the one value admitted, object or not", () => {
    expect(schemaRootAsksOutsideNamedValues({ const: {} })).toBe(false);
    expect(schemaRootAsksOutsideNamedValues({ const: "only this" })).toBe(true);
  });

  it("terminates over a root that reaches itself, and mints no refusal from the give-up", () => {
    // The arms are caller-supplied, so a self-reaching root would never return; the give-up
    // admits rather than refuses.
    const selfReaching: Record<string, unknown> = { properties: {} };
    selfReaching["allOf"] = [selfReaching];

    expect(schemaRootAsksOutsideNamedValues(selfReaching)).toBe(false);
  });

  it("reads one schema named by two arms twice, because the guard holds the path", () => {
    // An ancestor set, not a history: remembering everything seen would answer the second arm
    // from the first and admit an alternation of one unanswerable schema with itself.
    const scalarArm = { type: "string" };

    expect(schemaRootAsksOutsideNamedValues({ oneOf: [scalarArm, scalarArm] })).toBe(true);
  });

  it("reads an alternation's arms with the same question, at any depth", () => {
    // The reading recurses: an alternation of alternations closes the set when every leaf does.
    const nestedScalars = {
      oneOf: [{ oneOf: [{ type: "string" }, { type: "number" }] }, { type: "boolean" }],
    };
    const nestedWithAnObject = {
      oneOf: [{ oneOf: [{ type: "string" }, { type: "object" }] }, { type: "boolean" }],
    };

    expect(schemaRootAsksOutsideNamedValues(nestedScalars)).toBe(true);
    expect(schemaRootAsksOutsideNamedValues(nestedWithAnObject)).toBe(false);
  });
});
