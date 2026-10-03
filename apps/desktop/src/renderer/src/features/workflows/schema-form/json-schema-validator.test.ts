// The schema reader throws on a schema it cannot read, and the wrapper must answer with a reason
// instead, for every value a definition could carry in place of a schema.

import { describe, expect, it } from "vitest";

import { compileSchemaValidator } from "./json-schema-validator.js";

describe("the schema validator wrapper", () => {
  it("answers with a reason instead of throwing when the reader cannot read the schema", () => {
    const validator = compileSchemaValidator({
      type: "object",
      properties: { linked: { $ref: "#/definitions/missing" } },
    });

    expect(validator.status).toBe("uncompilable");
    if (validator.status !== "uncompilable") {
      return;
    }
    // The reason travels so an author has something to change.
    expect(validator.detail).toContain("only the JSON itself is checked");
  });

  it("does not throw for any of the values a definition could carry in place of a schema", () => {
    for (const unreadable of [undefined, null, 7, "text", [], { type: "nonsense" }]) {
      expect(() => compileSchemaValidator(unreadable)).not.toThrow();
    }
  });
});
