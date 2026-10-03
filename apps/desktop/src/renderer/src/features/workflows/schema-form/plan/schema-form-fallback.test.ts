// The mapper never refuses: whatever a definition carries in place of a schema, the form still
// opens, on the raw JSON editor.

import { describe, expect, it } from "vitest";

import { planSchemaForm } from "./schema-form-plan.js";

describe("the schema field mapper's raw arm", () => {
  it("resolves a schema it cannot read at all to the raw arm", () => {
    for (const unreadable of [undefined, null, 42, "a schema", [], { $ref: "#/x" }]) {
      expect(planSchemaForm(unreadable).shape).toBe("raw");
    }
  });
});
