// The three answers this module gives that the hook's own suite cannot reach through a
// mounted form: a plan that drew no controls at all, a collection nobody asked about, and
// a `default` whose shape is not the one its member's control renders.
//
// Driven through the real mapper rather than a hand-built plan, because a fabricated
// descriptor would pass with `planSchemaForm` deleted — and because the shapes under test
// are exactly the ones the mapper is what decides.

import { describe, expect, it } from "vitest";

import { newListEntryFor, seedAnswerFromPlan } from "./schema-answer.js";
import { planSchemaForm } from "./schema-fields.js";

describe("what a drawn form opens holding", () => {
  it("seeds nothing at all for a schema answered as raw JSON", () => {
    // The raw arm has no controls, so there is nothing for a seed to be visible in —
    // and its document is the person's, which nothing here writes into.
    expect(seedAnswerFromPlan(planSchemaForm({ type: "string" }))).toEqual({});
  });

  it("refuses a collection default that is not a list of entries", () => {
    const plan = planSchemaForm({
      type: "object",
      properties: { reviewers: { type: "array", items: { type: "string" }, default: "ada" } },
    });

    // Seeding the string would leave the answer holding "ada" at a member whose control
    // draws entries — the answer saying one thing while the surface showed another.
    expect(seedAnswerFromPlan(plan)).toEqual({});
  });

  it("negative control: a collection default that IS a list of entries is seeded", () => {
    const plan = planSchemaForm({
      type: "object",
      properties: { reviewers: { type: "array", items: { type: "string" }, default: ["ada"] } },
    });

    expect(seedAnswerFromPlan(plan)).toEqual({ reviewers: ["ada"] });
  });
});

describe("what an added list entry opens holding", () => {
  const listSchema = {
    type: "object",
    properties: {
      names: { type: "array", items: { type: "string" } },
      flags: { type: "array", items: { type: "boolean", default: true } },
    },
  };

  it("opens a repeated entry at the value its item schema declared", () => {
    expect(newListEntryFor(planSchemaForm(listSchema), ["flags"])).toBe(true);
  });

  it("opens a repeated entry with nothing declared as the empty text a control shows", () => {
    expect(newListEntryFor(planSchemaForm(listSchema), ["names"])).toBe("");
  });

  it("answers for a collection this form never drew rather than throwing", () => {
    // A caller asking about a member no control exists for is asking about a form it does
    // not have — which is a value question and never a crash, like every read here.
    expect(newListEntryFor(planSchemaForm(listSchema), ["absent"])).toBe("");
  });
});
