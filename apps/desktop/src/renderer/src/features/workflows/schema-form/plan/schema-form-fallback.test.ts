// What the mapper declines to draw: each cause is reachable and names the member that sent it
// there. What it does draw is `schema-form-plan.test.ts`. A fallback case is paired with a
// negative control wherever the check could pass by refusing everything.

import { describe, expect, it } from "vitest";

import { planSchemaForm } from "./schema-form-plan.js";
import { drawnEntries, objectSchema } from "./schema-form-plan.test-support.js";

describe("the schema field mapper's raw arm", () => {
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
    // A value for a member the group does not have reaches the schema's own reading of the
    // answer and no control.
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
    // This form offers one control for `kind` and none for either member the constraint can ask
    // for, so the finding is visible and nothing on screen can clear it.
    const plan = planSchemaForm({
      ...objectSchema({ kind: { type: "string" } }),
      oneOf: [{ required: ["email"] }, { required: ["phone"] }],
    });

    expect(plan.shape).toBe("raw");
    if (plan.shape !== "raw") {
      return;
    }
    expect(plan.fallback.cause).toBe("constraint-undrawable");
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

  it("sends a group's own combinator requiring a member it draws no control for to the raw editor", () => {
    // The root case one level down: `release` draws `tag` but not `signedBy`. The member is named
    // by its full path because `signedBy` alone is not findable in a schema with two groups.
    const plan = planSchemaForm(
      objectSchema({
        release: {
          ...objectSchema({ tag: { type: "string" } }),
          oneOf: [{ required: ["signedBy"] }, { required: ["tag"] }],
        },
      }),
    );

    expect(plan.shape).toBe("raw");
    if (plan.shape !== "raw") {
      return;
    }
    expect(plan.fallback.cause).toBe("constraint-undrawable");
    expect(plan.fallback.memberPath).toEqual(["release", "signedBy"]);
    expect(plan.fallback.detail).toContain("/release/signedBy");
  });

  it("sends a group whose own required list names a member it declares to the raw editor", () => {
    // The commonest form of the defect: a `required` entry with no matching property.
    expect(
      planSchemaForm(
        objectSchema({
          release: objectSchema({ tag: { type: "string" } }, ["tag", "signedBy"]),
        }),
      ),
    ).toMatchObject({
      shape: "raw",
      fallback: { cause: "constraint-undrawable", memberPath: ["release", "signedBy"] },
    });
  });

  it("negative control: a group combinator requiring only members it draws stays a drawn form", () => {
    const plan = planSchemaForm(
      objectSchema({
        release: {
          ...objectSchema({ tag: { type: "string" }, signedBy: { type: "string" } }),
          oneOf: [{ required: ["signedBy"] }, { required: ["tag"] }],
        },
      }),
    );
    const [entry] = drawnEntries(plan);

    expect(entry?.form === "group" ? entry.group.entries.length : undefined).toBe(2);
  });

  it("sends a dependency that can require an undrawn member to the raw editor", () => {
    const plan = planSchemaForm({
      ...objectSchema({ card: { type: "string" } }),
      dependentRequired: { card: ["billingAddress"] },
    });

    expect(plan).toMatchObject({
      shape: "raw",
      fallback: { cause: "constraint-undrawable", memberPath: ["billingAddress"] },
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
    // The item's `default` is what every added entry opens holding.
    const plan = planSchemaForm(
      objectSchema({ scores: { type: "array", items: { type: "number", default: "high" } } }),
    );

    expect(plan).toMatchObject({
      shape: "raw",
      fallback: { cause: "default-undrawable", memberPath: ["scores"] },
    });
  });

  it("sends an enumerated default the choice control could not offer to the raw editor", () => {
    // The control offers the enumeration's members and one unanswered option, so a declared value
    // outside the set shows "Not answered" while the seed carries it.
    const plan = planSchemaForm(
      objectSchema({ severity: { type: "string", enum: ["low", "high"], default: "retired" } }),
    );

    expect(plan).toMatchObject({
      shape: "raw",
      fallback: { cause: "default-undrawable", memberPath: ["severity"] },
    });
  });

  it("sends a collection default holding one entry outside the enumeration to the raw editor", () => {
    // One bad entry in a drawable list: its control shows the unanswered option while the answer
    // carries the author's string.
    const plan = planSchemaForm(
      objectSchema({
        severities: {
          type: "array",
          items: { type: "string", enum: ["low", "high"] },
          default: ["low", "retired"],
        },
      }),
    );

    expect(plan).toMatchObject({
      shape: "raw",
      fallback: { cause: "default-undrawable", memberPath: ["severities"] },
    });
  });

  it("sends a repeated choice's own default outside its enumeration to the raw editor", () => {
    const plan = planSchemaForm(
      objectSchema({
        severities: { type: "array", items: { type: "string", enum: ["low"], default: "retired" } },
      }),
    );

    expect(plan).toMatchObject({
      shape: "raw",
      fallback: { cause: "default-undrawable", memberPath: ["severities"] },
    });
  });

  it("sends a group default whose enumerated member is outside its enumeration to the raw editor", () => {
    const plan = planSchemaForm(
      objectSchema({
        release: {
          ...objectSchema({ severity: { type: "string", enum: ["low"] } }),
          default: { severity: "retired" },
        },
      }),
    );

    expect(plan).toMatchObject({
      shape: "raw",
      fallback: { cause: "default-undrawable", memberPath: ["release"] },
    });
  });

  it("negative control: enumerated defaults their own control can offer are drawn and carried", () => {
    const plan = planSchemaForm(
      objectSchema({
        severity: { type: "string", enum: ["low", "high"], default: "high" },
        severities: {
          type: "array",
          items: { type: "string", enum: ["low"], default: "low" },
          default: ["low"],
        },
      }),
    );
    const [severity, severities] = drawnEntries(plan);

    expect(severity?.form === "field" ? severity.field.defaultValue : undefined).toBe("high");
    expect(severities?.form === "list" ? severities.list.defaultValue : undefined).toEqual(["low"]);
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
