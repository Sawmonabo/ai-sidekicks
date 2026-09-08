// What the mapper draws, and — the half that matters more — what it declines to draw.
//
// The cases are written against the field set the corpus fixes for a human phase, so a
// kind that stopped resolving would fail by name rather than by a count. The fallback
// cases are the ones this module exists for: each cause the mapper itself minds is reachable, and
// each of them names the member that sent it there, because "this could not be drawn"
// with nothing named is a sentence nobody can act on.

import { describe, expect, it } from "vitest";

import { leafPathOf, SCHEMA_FIELD_KINDS, type SchemaFormPlan } from "./schema-fields.js";
import { planSchemaForm } from "./schema-form-plan.js";

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
    expect(plan.fallback.detail).toContain("/nested/deeper");
  });

  it("sends an array of objects to the raw editor rather than repeating a shape it has no control for", () => {
    const plan = planSchemaForm(
      objectSchema({ rows: { type: "array", items: objectSchema({ a: { type: "string" } }) } }),
    );

    expect(plan).toMatchObject({ shape: "raw", fallback: { memberPath: ["rows"] } });
  });

  it("sends a group default that is not a set of named values to the raw editor", () => {
    const plan = planSchemaForm(
      objectSchema({
        release: { ...objectSchema({ tag: { type: "string" } }), default: "v1" },
      }),
    );

    expect(plan.shape).toBe("raw");
    if (plan.shape !== "raw") {
      return;
    }
    expect(plan.fallback.cause).toBe("default-undrawable");
    expect(plan.fallback.memberPath).toEqual(["release"]);
    expect(plan.fallback.detail).toContain("/release");
  });

  it("sends a group default whose member is not the kind its control draws to the raw editor", () => {
    const plan = planSchemaForm(
      objectSchema({
        release: { ...objectSchema({ tag: { type: "string" } }), default: { tag: 7 } },
      }),
    );

    expect(plan).toMatchObject({
      shape: "raw",
      fallback: { cause: "default-undrawable", memberPath: ["release"] },
    });
  });

  it("sends a group default whose repeated member holds the wrong entries to the raw editor", () => {
    const plan = planSchemaForm(
      objectSchema({
        release: {
          ...objectSchema({ reviewers: { type: "array", items: { type: "string" } } }),
          default: { reviewers: [7] },
        },
      }),
    );

    expect(plan).toMatchObject({
      shape: "raw",
      fallback: { cause: "default-undrawable", memberPath: ["release"] },
    });
  });

  it("sends a group default naming a member no control draws to the raw editor", () => {
    // A value the group declares for a member it does not have reaches the schema's own
    // reading of the answer and reaches no control at all, which is the divergence the
    // whole seed exists to close.
    const plan = planSchemaForm(
      objectSchema({
        release: { ...objectSchema({ tag: { type: "string" } }), default: { ghost: "v1" } },
      }),
    );

    expect(plan).toMatchObject({
      shape: "raw",
      fallback: { cause: "default-undrawable", memberPath: ["release"] },
    });
  });

  it("negative control: a group default its controls can show is drawn and carried", () => {
    const plan = planSchemaForm(
      objectSchema({
        release: { ...objectSchema({ tag: { type: "string" } }), default: { tag: "v1" } },
      }),
    );
    const [entry] = drawnEntries(plan);

    expect(entry?.form === "group" ? entry.group.defaultValue : undefined).toEqual({ tag: "v1" });
  });

  it("sends a root combinator that can require a member no control draws to the raw editor", () => {
    // Drawn, this form offers one control for `kind` and none for either member the
    // constraint can ask for — so the root finding is visible and there is nothing on the
    // screen a person could do about it.
    const plan = planSchemaForm({
      ...objectSchema({ kind: { type: "string" } }),
      oneOf: [{ required: ["email"] }, { required: ["phone"] }],
    });

    expect(plan.shape).toBe("raw");
    if (plan.shape !== "raw") {
      return;
    }
    expect(plan.fallback.cause).toBe("root-constraint-undrawable");
    expect(plan.fallback.memberPath).toEqual(["email"]);
    expect(plan.fallback.detail).toContain("/email");
  });

  it("negative control: a root combinator requiring only drawn members stays a drawn form", () => {
    const plan = planSchemaForm({
      ...objectSchema({ email: { type: "string" }, phone: { type: "string" } }),
      oneOf: [{ required: ["email"] }, { required: ["phone"] }],
    });

    const [email, phone] = drawnEntries(plan);

    expect(email?.form === "field" ? email.field.memberPath : undefined).toEqual(["email"]);
    expect(phone?.form === "field" ? phone.field.memberPath : undefined).toEqual(["phone"]);
  });

  it("sends a dependency that can require an undrawn member to the raw editor", () => {
    const plan = planSchemaForm({
      ...objectSchema({ card: { type: "string" } }),
      dependentRequired: { card: ["billingAddress"] },
    });

    expect(plan).toMatchObject({
      shape: "raw",
      fallback: { cause: "root-constraint-undrawable", memberPath: ["billingAddress"] },
    });
  });

  it("sends a scalar default its own control could not display to the raw editor", () => {
    const plan = planSchemaForm(objectSchema({ retries: { type: "number", default: "auto" } }));

    expect(plan).toMatchObject({
      shape: "raw",
      fallback: { cause: "default-undrawable", memberPath: ["retries"] },
    });
  });

  it("sends a collection default that is not a list of drawable entries to the raw editor", () => {
    for (const declared of ["ada", [7]]) {
      expect(
        planSchemaForm(
          objectSchema({
            reviewers: { type: "array", items: { type: "string" }, default: declared },
          }),
        ),
      ).toMatchObject({
        shape: "raw",
        fallback: { cause: "default-undrawable", memberPath: ["reviewers"] },
      });
    }
  });

  it("sends a repeated control's own default its entry could not display to the raw editor", () => {
    // The item's `default` is what EVERY added entry opens holding, so a value of another
    // kind is the same divergence repeated once per press of the add control.
    const plan = planSchemaForm(
      objectSchema({ scores: { type: "array", items: { type: "number", default: "high" } } }),
    );

    expect(plan).toMatchObject({
      shape: "raw",
      fallback: { cause: "default-undrawable", memberPath: ["scores"] },
    });
  });

  it("negative control: declared values their own controls can show are drawn and carried", () => {
    const plan = planSchemaForm(
      objectSchema({
        retries: { type: "number", default: 3 },
        reviewers: { type: "array", items: { type: "string", default: "ada" }, default: ["ada"] },
      }),
    );
    const [retries, reviewers] = drawnEntries(plan);

    expect(retries?.form === "field" ? retries.field.defaultValue : undefined).toBe(3);
    expect(reviewers?.form === "list" ? reviewers.list.defaultValue : undefined).toEqual(["ada"]);
    expect(reviewers?.form === "list" ? reviewers.list.item.defaultValue : undefined).toBe("ada");
  });

  it("never refuses: a schema it cannot read at all still resolves to the raw arm", () => {
    for (const unreadable of [undefined, null, 42, "a schema", [], { $ref: "#/x" }]) {
      expect(planSchemaForm(unreadable).shape).toBe("raw");
    }
  });
});
