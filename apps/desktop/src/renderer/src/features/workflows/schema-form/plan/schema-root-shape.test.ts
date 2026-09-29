// Which roots this console can answer at all, and which it refuses.
//
// The rule is a contract reading rather than a taste: a submitted answer travels as a set
// of named values, so the cases below are the root declarations a phase could write, each
// asserted against whether an answer for it could reach the wire.

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
    // The array spelling declares the whole set the root admits, so a union of `string`
    // and `null` is exactly as unanswerable as a bare `string` — and it was admitted while
    // the reading asked only which single type was spelled.
    expect(schemaRootAsksOutsideNamedValues({ type: ["string", "null"] })).toBe(true);
    expect(schemaRootAsksOutsideNamedValues({ type: ["string", "object"] })).toBe(false);
  });

  it("admits the object root, which is the shape the submitted answer is", () => {
    expect(schemaRootAsksOutsideNamedValues({ type: "object", properties: {} })).toBe(false);
    expect(schemaRootRefusal({ type: "object" })).toBeUndefined();
  });

  it("admits a root that declares no type at all, which asked for nothing in particular", () => {
    // The negative half of the rule: an absent or unreadable root says nothing about
    // whether the answer may be an object, so it is not this fault and the mapper's own
    // raw editor stays answerable there.
    expect(schemaRootAsksOutsideNamedValues(undefined)).toBe(false);
    expect(schemaRootAsksOutsideNamedValues("not a schema at all")).toBe(false);
    expect(schemaRootAsksOutsideNamedValues({ properties: {} })).toBe(false);
  });

  it("carries the refusal code and one sentence naming the definition as the remedy", () => {
    const refusal = schemaRootRefusal({ type: "string" });

    expect(refusal?.code).toBe(SCHEMA_ROOT_NOT_NAMED_VALUES);
    expect(refusal?.detail).toContain("definition");
    // Never the schema's own words: `type` is author-written, and this sentence is fixed.
    expect(refusal?.detail).not.toContain("string");
  });
});

describe("a root that closes the answer set without naming a type", () => {
  // The whole class this suite was extended for: none of these roots spells a `type`, so
  // a reading that asked only that question admitted every one of them and the surface
  // offered an editor whose every schema-valid answer the submit surface then refuses.
  it("refuses an alternation no arm of which an object could satisfy", () => {
    const stringOrNumber = { oneOf: [{ type: "string" }, { type: "number" }] };

    expect(schemaRootAsksOutsideNamedValues(stringOrNumber)).toBe(true);
    expect(schemaRootRefusal(stringOrNumber)?.code).toBe(SCHEMA_ROOT_NOT_NAMED_VALUES);
    // What the surface would have rendered instead, read from the real mapper rather than
    // described: the plan for this root is the raw arm, so before the refusal existed the
    // editor was drawn and the act beside it was offered.
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
    // `allOf` is the other quantifier: an answer has to satisfy every arm, so one
    // unanswerable arm closes the set however many object arms sit beside it.
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
    // The arms are values a caller supplied, so a root that reaches itself is a probe that
    // would otherwise never return — the hazard `schema-constraints.ts` guards beside this.
    // A schema that is its own ancestor answers "possible", so the give-up admits rather
    // than refusing: this module only ever refuses on a reading it finished.
    const selfReaching: Record<string, unknown> = { properties: {} };
    selfReaching["allOf"] = [selfReaching];

    expect(schemaRootAsksOutsideNamedValues(selfReaching)).toBe(false);
  });

  it("reads one schema named by two arms twice, because the guard holds the path", () => {
    // The other half of the guard, and what makes it an ANCESTOR set rather than a history:
    // a set that remembered everything seen would answer the second arm from the first
    // arm's entry, so an alternation of one unanswerable schema with itself would come back
    // admitted. Both arms are the same object here, and both have to be read.
    const scalarArm = { type: "string" };

    expect(schemaRootAsksOutsideNamedValues({ oneOf: [scalarArm, scalarArm] })).toBe(true);
  });

  it("reads an alternation's arms with the same question, at any depth", () => {
    // The arms are schemas, so the reading recurses rather than special-casing one level:
    // an alternation of alternations closes the set exactly when every leaf does.
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
