// What a drawn form opens holding: never a `default` its control cannot display, and a group's
// own default carried into the child control it names, so the first press sends what the person
// sees. Driven through the real mapper, since a fabricated descriptor would pass with
// `planSchemaForm` deleted.

import { describe, expect, it } from "vitest";

import { seedDraftFromPlan } from "./schema-answer.js";
import { planSchemaForm } from "../plan/schema-form-plan.js";
import { projectAnswer } from "./schema-projection.js";
import type { SchemaFormPlan } from "../plan/schema-fields.js";

/**
 * The answer a form opens holding: the seeded draft through the one projection, so it is exactly
 * what the first press would send.
 */
function openingAnswer(plan: SchemaFormPlan): unknown {
  return projectAnswer(plan, seedDraftFromPlan(plan));
}

describe("what a drawn form opens holding", () => {
  it("seeds nothing a control could not display, whatever the schema declared", () => {
    const plan = planSchemaForm({
      type: "object",
      properties: { retries: { type: "number", default: "auto" } },
    });

    // Seeded, "auto" would reach the submission while `SchemaNumberField` shows a blank box.
    expect(openingAnswer(plan)).toEqual({});
  });

  it("seeds nothing for an enumerated default the choice control could not offer", () => {
    const plan = planSchemaForm({
      type: "object",
      properties: { severity: { type: "string", enum: ["low", "high"], default: "retired" } },
    });

    // Seeded, "retired" would reach the submission while the select shows "Not answered".
    expect(openingAnswer(plan)).toEqual({});
  });
});

describe("a value declared on the group rather than on the control that shows it", () => {
  it("carries a group's own default into the child control it names", () => {
    const plan = planSchemaForm({
      type: "object",
      properties: {
        release: {
          type: "object",
          default: { tag: "v1" },
          properties: { tag: { type: "string" } },
        },
      },
    });

    // Dropped, `tag` would open blank while the schema reads `{}` as `{ release: { tag: "v1" } }`,
    // so a press would send bytes other than the accepted value.
    expect(openingAnswer(plan)).toEqual({ release: { tag: "v1" } });
  });
});
