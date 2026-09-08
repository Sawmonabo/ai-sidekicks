// Which roots this console can answer at all, and which it refuses.
//
// The rule is a contract reading rather than a taste: a submitted answer travels as a set
// of named values, so the cases below are the JSON Schema root types a phase could
// declare, each asserted against whether an answer for it could reach the wire.

import { describe, expect, it } from "vitest";

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

  it("admits the object root, which is the shape the submitted answer is", () => {
    expect(schemaRootAsksOutsideNamedValues({ type: "object", properties: {} })).toBe(false);
    expect(schemaRootRefusal({ type: "object" })).toBeUndefined();
  });

  it("admits a root that declares no type at all, which asked for nothing in particular", () => {
    // The negative half of the rule: an absent, unreadable, or union-typed root says
    // nothing about whether the answer may be an object, so it is not this fault and the
    // mapper's own raw editor stays answerable there.
    expect(schemaRootAsksOutsideNamedValues(undefined)).toBe(false);
    expect(schemaRootAsksOutsideNamedValues("not a schema at all")).toBe(false);
    expect(schemaRootAsksOutsideNamedValues({ properties: {} })).toBe(false);
    expect(schemaRootAsksOutsideNamedValues({ type: ["string", "null"] })).toBe(false);
  });

  it("carries the refusal code and one sentence naming the definition as the remedy", () => {
    const refusal = schemaRootRefusal({ type: "string" });

    expect(refusal?.code).toBe(SCHEMA_ROOT_NOT_NAMED_VALUES);
    expect(refusal?.detail).toContain("definition");
    // Never the schema's own words: `type` is author-written, and this sentence is fixed.
    expect(refusal?.detail).not.toContain("string");
  });
});
