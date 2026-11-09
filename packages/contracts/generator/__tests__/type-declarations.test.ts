// The declared types must carry every member the generated check requires, or a reader of the
// member fails to type-check against a value the check takes.
import { describe, expect, it } from "vitest";

import { ModuleImports } from "../module-imports.ts";
import { generateTypes } from "../type-declarations.ts";

/** The types written for one definition, `Page`, of a module of its own. */
async function declarePage(page: Record<string, unknown>): Promise<string> {
  return generateTypes({ $defs: { Page: page } }, new ModuleImports("page", new Set(["Page"])));
}

describe("generateTypes", () => {
  // Killed by dropping `title` from a `properties` map as from a schema's own keywords.
  it("declares a member named title beside a schema's own title", async () => {
    const types = await declarePage({
      title: "Shown page",
      type: "object",
      additionalProperties: false,
      required: ["title"],
      properties: { title: { type: "string", title: "Its title" } },
    });

    expect(types).toBe("export interface Page {\ntitle: string\n}");
  });

  // Killed by keeping an arm typed `never` in a union.
  it("declares a nullable of the impossible type as null", async () => {
    const types = await declarePage({
      type: "object",
      additionalProperties: false,
      required: ["holder"],
      properties: { holder: { anyOf: [{ not: {}, tsType: "never" }, { type: "null" }] } },
    });

    expect(types).toBe("export interface Page {\nholder: null\n}");
  });
});
