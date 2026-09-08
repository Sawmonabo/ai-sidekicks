// What a drawn form opens holding, at the one seam the hook's own suite cannot reach
// through a mounted form: a plan that drew no controls at all, a collection nobody asked
// about, a `default` whose shape is not the one its member's control renders, and the
// value one added entry of a list starts at.
//
// Driven through the real mapper rather than a hand-built plan, because a fabricated
// descriptor would pass with `planSchemaForm` deleted — and because the shapes under test
// are exactly the ones the mapper is what decides.

import { describe, expect, it } from "vitest";

import { newListEntryFor, seedAnswerFromPlan } from "./schema-answer.js";
import { planSchemaForm } from "./schema-form-plan.js";

describe("what a drawn form opens holding", () => {
  it("seeds nothing at all for a schema answered as raw JSON", () => {
    // The raw arm has no controls, so there is nothing for a seed to be visible in —
    // and its document is the person's, which nothing here writes into.
    expect(seedAnswerFromPlan(planSchemaForm({ type: "string" }))).toEqual({});
  });

  it("opens a drawn collection at the empty list its control already renders", () => {
    const plan = planSchemaForm({
      type: "object",
      properties: { reviewers: { type: "array", items: { type: "string" } } },
    });

    // The list is DRAWN — an empty collection with its add control — so the answer says
    // the same thing the surface does. Omitting the member left a required array that
    // legally accepts zero entries unsubmittable until somebody added an entry and
    // removed it again.
    expect(seedAnswerFromPlan(plan)).toEqual({ reviewers: [] });
  });

  it("seeds nothing for a collection whose declared default is not a list of entries", () => {
    const plan = planSchemaForm({
      type: "object",
      properties: { reviewers: { type: "array", items: { type: "string" }, default: "ada" } },
    });

    // The mapper never draws this collection at all — a declared value its control could
    // not show sends the whole schema to the raw editor — so there is no control here for
    // "ada" to be invisible in, and the seed is the raw arm's empty one.
    expect(seedAnswerFromPlan(plan)).toEqual({});
  });

  it("seeds nothing a control could not display, whatever the schema declared", () => {
    const plan = planSchemaForm({
      type: "object",
      properties: { retries: { type: "number", default: "auto" } },
    });

    // Seeded, "auto" reached the submission while `SchemaNumberField` rendered a blank
    // box: the answer carrying text nobody had seen or could clear.
    expect(seedAnswerFromPlan(plan)).toEqual({});
  });

  it("seeds nothing for an enumerated default the choice control could not offer", () => {
    const plan = planSchemaForm({
      type: "object",
      properties: { severity: { type: "string", enum: ["low", "high"], default: "retired" } },
    });

    // Seeded, "retired" reached the submission while the select showed "Not answered":
    // the answer carrying a member the control on the screen was not displaying.
    expect(seedAnswerFromPlan(plan)).toEqual({});
  });

  it("opens an optional yes-or-no unanswered rather than at the no a box would show", () => {
    const plan = planSchemaForm({
      type: "object",
      properties: { notify: { type: "boolean" } },
    });

    // A member the schema does not demand can be left out, and a two-state box has no
    // state that says so — which is why an optional boolean is drawn as a three-state
    // choice. Seeded `false`, a schema requiring this member's ABSENCE had no answer the
    // drawn form could reach.
    expect(seedAnswerFromPlan(plan)).toEqual({});
  });

  it("negative control: a required yes-or-no still opens at the false its box shows", () => {
    const plan = planSchemaForm({
      type: "object",
      properties: { notify: { type: "boolean" } },
      required: ["notify"],
    });

    expect(seedAnswerFromPlan(plan)).toEqual({ notify: false });
  });

  it("negative control: a collection default that IS a list of entries is seeded", () => {
    const plan = planSchemaForm({
      type: "object",
      properties: { reviewers: { type: "array", items: { type: "string" }, default: ["ada"] } },
    });

    expect(seedAnswerFromPlan(plan)).toEqual({ reviewers: ["ada"] });
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

    // Dropped, the `tag` control opened blank while the schema's own reading of `{}` was
    // `{ release: { tag: "v1" } }` — so the form read valid and a press sent bytes
    // different from the value that was accepted.
    expect(seedAnswerFromPlan(plan)).toEqual({ release: { tag: "v1" } });
  });

  it("lets a child's own default win over the group's for the same member", () => {
    const plan = planSchemaForm({
      type: "object",
      properties: {
        release: {
          type: "object",
          default: { tag: "v1" },
          properties: { tag: { type: "string", default: "v2" } },
        },
      },
    });

    // The nearest declared value on the path, which is the control's own.
    expect(seedAnswerFromPlan(plan)).toEqual({ release: { tag: "v2" } });
  });

  it("carries a group default onto a collection the group holds", () => {
    const plan = planSchemaForm({
      type: "object",
      properties: {
        release: {
          type: "object",
          default: { reviewers: ["ada"] },
          properties: { reviewers: { type: "array", items: { type: "string" } } },
        },
      },
    });

    expect(seedAnswerFromPlan(plan)).toEqual({ release: { reviewers: ["ada"] } });
  });

  it("seeds nothing for a group default that names no member of it", () => {
    const plan = planSchemaForm({
      type: "object",
      properties: {
        release: {
          type: "object",
          default: {},
          properties: { tag: { type: "string" }, signed: { type: "boolean" } },
          // Required, so the box is the control this member draws through and `false` is
          // the state it is already showing. Optional, the same member is a three-state
          // choice that opens absent, which is a different case and is pinned above.
          required: ["signed"],
        },
      },
    });

    // An empty declared value names nothing, so each control opens where it would have
    // anyway — which for the box is the `false` it is already showing.
    expect(seedAnswerFromPlan(plan)).toEqual({ release: { signed: false } });
  });
});

describe("what an added list entry opens holding", () => {
  const listSchema = {
    type: "object",
    properties: {
      names: { type: "array", items: { type: "string" } },
      flags: { type: "array", items: { type: "boolean", default: true } },
      scores: { type: "array", items: { type: "number" } },
      tiers: { type: "array", items: { enum: ["", "high"] } },
      evidence: { type: "array", items: { type: "string", format: "artifact" } },
    },
  };

  it("opens a repeated entry at the value its item schema declared", () => {
    expect(newListEntryFor(planSchemaForm(listSchema), ["flags"])).toBe(true);
  });

  it("opens a repeated entry with nothing declared as the empty text a control shows", () => {
    expect(newListEntryFor(planSchemaForm(listSchema), ["names"])).toBe("");
  });

  it("opens a repeated number unanswered rather than as the empty string", () => {
    // A number control shows nothing for a string, so `""` there is a payload holding a
    // value no control on the screen is displaying.
    expect(newListEntryFor(planSchemaForm(listSchema), ["scores"])).toBeUndefined();
  });

  it("opens a repeated choice unanswered, including one whose enumeration spells empty", () => {
    // `""` is a member this enumeration legitimately contains, so inserting it would have
    // answered the question the moment somebody pressed the add control.
    expect(newListEntryFor(planSchemaForm(listSchema), ["tiers"])).toBeUndefined();
  });

  it("opens a repeated artifact reference unanswered rather than as an empty identifier", () => {
    expect(newListEntryFor(planSchemaForm(listSchema), ["evidence"])).toBeUndefined();
  });

  it("answers for a collection this form never drew rather than throwing", () => {
    // A caller asking about a member no control exists for is asking about a form it does
    // not have — which is a value question and never a crash, like every read here. There
    // is no control to derive an opening value from, so there is no value.
    expect(newListEntryFor(planSchemaForm(listSchema), ["absent"])).toBeUndefined();
  });
});
