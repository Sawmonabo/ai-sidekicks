// What the mapper draws, and — the half that matters more — what it declines to draw.
//
// The cases are written against the field set the corpus fixes for a human phase, so a
// kind that stopped resolving would fail by name rather than by a count. The fallback
// cases are the ones this module exists for: each of the three causes is reachable, and
// each of them names the member that sent it there, because "this could not be drawn"
// with nothing named is a sentence nobody can act on.

import { describe, expect, it } from "vitest";

import { SCHEMA_FIELD_KINDS, planSchemaForm, type SchemaFormPlan } from "./schema-fields.js";

/** One object schema over the given members, with the given ones required. */
function objectSchema(
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  return { type: "object", properties, required };
}

/** The entries a drawn plan resolved to, or a failure naming what it resolved to instead. */
function drawnEntries(plan: SchemaFormPlan) {
  if (plan.shape !== "fields") {
    throw new Error(`expected drawn controls, got the raw arm: ${plan.fallback.cause}`);
  }
  return plan.entries;
}

describe("the schema field mapper", () => {
  it("resolves each of the six declared kinds from its own schema shape", () => {
    const plan = planSchemaForm(
      objectSchema({
        title: { type: "string" },
        notes: { type: "string", format: "long_text" },
        count: { type: "integer" },
        approved: { type: "boolean" },
        severity: { type: "string", enum: ["low", "high"] },
        evidence: { type: "string", format: "artifact" },
      }),
    );

    const kinds = drawnEntries(plan).map((entry) =>
      entry.form === "field" ? entry.field.kind : entry.form,
    );

    expect(kinds).toEqual([
      "text",
      "long-text",
      "number",
      "checkbox",
      "choice",
      "artifact-reference",
    ]);
    // Every declared kind is reachable from a schema, which is what makes the tuple a
    // render set rather than a list with an arm nothing can produce.
    expect([...SCHEMA_FIELD_KINDS].sort()).toEqual([...new Set(kinds)].sort());
  });

  it("reads an enumerated string as a choice rather than as text", () => {
    const [entry] = drawnEntries(
      planSchemaForm(objectSchema({ tier: { type: "string", enum: ["a"] } })),
    );

    expect(entry?.form).toBe("field");
    if (entry?.form !== "field") {
      return;
    }
    expect(entry.field.kind).toBe("choice");
    expect(entry.field.choices).toEqual(["a"]);
  });

  it("carries requiredness, the schema's title, and its description onto the field", () => {
    const [entry] = drawnEntries(
      planSchemaForm(
        objectSchema(
          { owner: { type: "string", title: "Who signs off", description: "A person." } },
          ["owner"],
        ),
      ),
    );

    expect(entry?.form === "field" ? entry.field : undefined).toMatchObject({
      label: "Who signs off",
      description: "A person.",
      isRequired: true,
      memberPath: ["owner"],
    });
  });

  it("marks an integer so its control can step by one", () => {
    const [entry] = drawnEntries(planSchemaForm(objectSchema({ attempts: { type: "integer" } })));

    expect(entry?.form === "field" ? entry.field.isInteger : undefined).toBe(true);
  });

  it("carries a declared multipleOf so its control steps by the schema's own step", () => {
    const [entry] = drawnEntries(
      planSchemaForm(objectSchema({ ratio: { type: "number", multipleOf: 0.25 } })),
    );

    expect(entry?.form === "field" ? entry.field.multipleOf : undefined).toBe(0.25);
  });

  it("carries no step for a multipleOf the schema could not mean", () => {
    // Zero and a negative are schemas the validator refuses on its own terms; a control
    // handed either as a step would refuse every answer before the verdict could say why.
    for (const declared of [0, -1, Number.NaN, "2"]) {
      const [entry] = drawnEntries(
        planSchemaForm(objectSchema({ ratio: { type: "number", multipleOf: declared } })),
      );

      expect(entry?.form === "field" ? entry.field.multipleOf : "not drawn").toBeUndefined();
    }
  });

  it("draws an array of one primitive as a list keyed at the array's own path", () => {
    const [entry] = drawnEntries(
      planSchemaForm(objectSchema({ reviewers: { type: "array", items: { type: "string" } } })),
    );

    expect(entry?.form).toBe("list");
    if (entry?.form !== "list") {
      return;
    }
    expect(entry.list.memberPath).toEqual(["reviewers"]);
    expect(entry.list.item.kind).toBe("text");
  });

  it("draws a one-level object as a group whose members carry the nested path", () => {
    const [entry] = drawnEntries(
      planSchemaForm(
        objectSchema({
          release: objectSchema({ tag: { type: "string" }, signed: { type: "boolean" } }, ["tag"]),
        }),
      ),
    );

    expect(entry?.form).toBe("group");
    if (entry?.form !== "group") {
      return;
    }
    expect(entry.group.entries.map((leaf) => leafPathOf(leaf))).toEqual([
      ["release", "tag"],
      ["release", "signed"],
    ]);
    expect(
      entry.group.entries[0]?.form === "field"
        ? entry.group.entries[0].field.isRequired
        : undefined,
    ).toBe(true);
  });

  it("sends a schema that is not an object to the raw editor with the whole-schema cause", () => {
    const plan = planSchemaForm({ type: "string" });

    expect(plan).toMatchObject({ shape: "raw", fallback: { cause: "root-not-an-object" } });
  });

  it("sends a schema with no members to the raw editor rather than drawing an empty form", () => {
    expect(planSchemaForm(objectSchema({}))).toMatchObject({
      shape: "raw",
      fallback: { cause: "no-members" },
    });
  });

  it("sends one out-of-set member to the raw editor and names which member it was", () => {
    const plan = planSchemaForm(
      objectSchema({
        fine: { type: "string" },
        nested: objectSchema({ deeper: objectSchema({ leaf: { type: "string" } }) }),
      }),
    );

    expect(plan.shape).toBe("raw");
    if (plan.shape !== "raw") {
      return;
    }
    expect(plan.fallback.cause).toBe("member-out-of-set");
    expect(plan.fallback.memberPath).toEqual(["nested", "deeper"]);
    expect(plan.fallback.detail).toContain("nested.deeper");
  });

  it("sends an array of objects to the raw editor rather than repeating a shape it has no control for", () => {
    const plan = planSchemaForm(
      objectSchema({ rows: { type: "array", items: objectSchema({ a: { type: "string" } }) } }),
    );

    expect(plan).toMatchObject({ shape: "raw", fallback: { memberPath: ["rows"] } });
  });

  it("never refuses: a schema it cannot read at all still resolves to the raw arm", () => {
    for (const unreadable of [undefined, null, 42, "a schema", [], { $ref: "#/x" }]) {
      expect(planSchemaForm(unreadable).shape).toBe("raw");
    }
  });
});

/** One leaf's addressed path, whichever of the two forms it took. */
function leafPathOf(
  leaf: { readonly form: "field" | "list" } & Record<string, unknown>,
): readonly string[] {
  const held = leaf.form === "field" ? leaf["field"] : leaf["list"];
  return (held as { readonly memberPath: readonly string[] }).memberPath;
}
