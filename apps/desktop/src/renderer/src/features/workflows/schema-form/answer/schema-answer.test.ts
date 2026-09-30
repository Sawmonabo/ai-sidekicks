// What a drawn form opens holding, at the seam the hook's suite cannot reach through a mounted
// form: a plan with no controls, a collection nobody asked about, a `default` whose shape the
// control does not render, and an added list entry's starting value. Driven through the real
// mapper, since a fabricated descriptor would pass with `planSchemaForm` deleted.

import { describe, expect, it } from "vitest";

import { newListEntryDraft, seedDraftFromPlan } from "./schema-answer.js";
import { answeredScalar, UNANSWERED_SCALAR } from "./schema-draft.js";
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
  it("seeds nothing at all for a schema answered as raw JSON", () => {
    // The raw arm has no controls, and its document is the person's.
    expect(openingAnswer(planSchemaForm({ type: "string" }))).toEqual({});
  });

  it("opens a REQUIRED collection at the empty list its control already renders", () => {
    const plan = planSchemaForm({
      type: "object",
      properties: { reviewers: { type: "array", items: { type: "string" } } },
      required: ["reviewers"],
    });

    // An empty list is what the fieldset already draws. Omitted, a required array accepting zero
    // entries opened invalid until an entry was added and removed.
    expect(openingAnswer(plan)).toEqual({ reviewers: [] });
  });

  it("opens an OPTIONAL collection absent, so a presence-sensitive schema is answerable", () => {
    const plan = planSchemaForm({
      type: "object",
      properties: { reviewers: { type: "array", items: { type: "string" }, minItems: 1 } },
    });

    // Seeded `[]`, the form opened invalid on a collection nobody had added to.
    expect(openingAnswer(plan)).toEqual({});
  });

  it("opens a REQUIRED group at the empty object its legend stands over", () => {
    const plan = planSchemaForm({
      type: "object",
      properties: {
        release: { type: "object", properties: { tag: { type: "string" } } },
      },
      required: ["release"],
    });

    // Every member is optional so no leaf contributes a value, yet the group is required. Left
    // to its leaves the answer held no `release`, and clearing `tag` produced
    // `{ release: { tag: "" } }`.
    expect(openingAnswer(plan)).toEqual({ release: {} });
  });

  it("keeps an OPTIONAL group absent even where its own members are required", () => {
    const plan = planSchemaForm({
      type: "object",
      properties: {
        settings: {
          type: "object",
          properties: { enabled: { type: "boolean" } },
          required: ["enabled"],
        },
      },
    });

    // `enabled` is required inside `settings`; seeding each member on its own requiredness opened
    // `{ settings: { enabled: false } }`, which a schema requiring the group absent could never
    // accept. The group opens inactive and is activated on its legend.
    expect(openingAnswer(plan)).toEqual({});
  });

  it("negative control: an OPTIONAL group with nothing answered into it stays absent", () => {
    const plan = planSchemaForm({
      type: "object",
      properties: {
        release: { type: "object", properties: { tag: { type: "string" } } },
      },
    });

    expect(openingAnswer(plan)).toEqual({});
  });

  it("seeds nothing for a collection whose declared default is not a list of entries", () => {
    const plan = planSchemaForm({
      type: "object",
      properties: { reviewers: { type: "array", items: { type: "string" }, default: "ada" } },
    });

    // The mapper never draws this collection (a declared value its control could not show sends
    // the schema to the raw editor), so the seed is the raw arm's empty one.
    expect(openingAnswer(plan)).toEqual({});
  });

  it("seeds nothing a control could not display, whatever the schema declared", () => {
    const plan = planSchemaForm({
      type: "object",
      properties: { retries: { type: "number", default: "auto" } },
    });

    // Seeded, "auto" reached the submission while `SchemaNumberField` rendered a blank box.
    expect(openingAnswer(plan)).toEqual({});
  });

  it("seeds nothing for an enumerated default the choice control could not offer", () => {
    const plan = planSchemaForm({
      type: "object",
      properties: { severity: { type: "string", enum: ["low", "high"], default: "retired" } },
    });

    // Seeded, "retired" reached the submission while the select showed "Not answered".
    expect(openingAnswer(plan)).toEqual({});
  });

  it("opens an optional yes-or-no unanswered rather than at the no a box would show", () => {
    const plan = planSchemaForm({
      type: "object",
      properties: { notify: { type: "boolean" } },
    });

    // A two-state box cannot say "left out", so an optional boolean draws as a three-state
    // choice. Seeded `false`, a schema requiring the member's absence was unreachable.
    expect(openingAnswer(plan)).toEqual({});
  });

  it("negative control: a required yes-or-no still opens at the false its box shows", () => {
    const plan = planSchemaForm({
      type: "object",
      properties: { notify: { type: "boolean" } },
      required: ["notify"],
    });

    expect(openingAnswer(plan)).toEqual({ notify: false });
  });

  it("negative control: a collection default that IS a list of entries is seeded", () => {
    const plan = planSchemaForm({
      type: "object",
      properties: { reviewers: { type: "array", items: { type: "string" }, default: ["ada"] } },
    });

    expect(openingAnswer(plan)).toEqual({ reviewers: ["ada"] });
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

    // Dropped, `tag` opened blank while the schema's reading of `{}` was
    // `{ release: { tag: "v1" } }`, so a press sent bytes other than the accepted value.
    expect(openingAnswer(plan)).toEqual({ release: { tag: "v1" } });
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

    expect(openingAnswer(plan)).toEqual({ release: { tag: "v2" } });
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

    expect(openingAnswer(plan)).toEqual({ release: { reviewers: ["ada"] } });
  });

  it("seeds nothing for a group default that names no member of it", () => {
    const plan = planSchemaForm({
      type: "object",
      properties: {
        release: {
          type: "object",
          default: {},
          properties: { tag: { type: "string" }, signed: { type: "boolean" } },
          // Required, so the box is a checkbox already showing `false`; optional, it is a
          // three-state choice that opens absent (pinned above).
          required: ["signed"],
        },
      },
    });

    // An empty declared value names nothing, so each control opens where it would have anyway.
    expect(openingAnswer(plan)).toEqual({ release: { signed: false } });
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
    },
  };

  it("opens a repeated entry at the value its item schema declared", () => {
    expect(newListEntryDraft(planSchemaForm(listSchema), ["flags"])).toEqual(answeredScalar(true));
  });

  it("opens a repeated entry with nothing declared as the empty text a control shows", () => {
    expect(newListEntryDraft(planSchemaForm(listSchema), ["names"])).toEqual(answeredScalar(""));
  });

  it("opens a repeated number unanswered rather than as the empty string", () => {
    // A number control shows nothing for a string, so `""` there is an unanswered node, not
    // `undefined`, which inside the answer's array serializes as `null`.
    expect(newListEntryDraft(planSchemaForm(listSchema), ["scores"])).toBe(UNANSWERED_SCALAR);
  });

  it("opens a repeated choice unanswered, including one whose enumeration spells empty", () => {
    // `""` is a legitimate member of this enumeration; inserting it would answer the question on
    // the add press.
    expect(newListEntryDraft(planSchemaForm(listSchema), ["tiers"])).toBe(UNANSWERED_SCALAR);
  });

  it("answers for a collection this form never drew rather than throwing", () => {
    // Asking about a member no control exists for is a value question, never a crash.
    expect(newListEntryDraft(planSchemaForm(listSchema), ["absent"])).toBeUndefined();
  });
});
