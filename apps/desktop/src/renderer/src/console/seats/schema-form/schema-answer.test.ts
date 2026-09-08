// What a drawn form opens holding, at the one seam the hook's own suite cannot reach
// through a mounted form: a plan that drew no controls at all, a collection nobody asked
// about, a `default` whose shape is not the one its member's control renders, and the
// value one added entry of a list starts at.
//
// Driven through the real mapper rather than a hand-built plan, because a fabricated
// descriptor would pass with `planSchemaForm` deleted — and because the shapes under test
// are exactly the ones the mapper is what decides.

import { describe, expect, it } from "vitest";

import { newListEntryDraft, seedDraftFromPlan } from "./schema-answer.js";
import { answeredScalar, UNANSWERED_SCALAR } from "./schema-draft.js";
import { planSchemaForm } from "./schema-form-plan.js";
import { projectAnswer } from "./schema-projection.js";
import type { SchemaFormPlan } from "./schema-fields.js";

/**
 * The answer a form opens holding: the seeded draft, through the one projection.
 *
 * Composed rather than read off a seed, because the seed is now a TREE and the answer is
 * a projection of it — so what a form opens holding is exactly what its first press would
 * send, asserted through the same two functions the mounted form runs.
 */
function openingAnswer(plan: SchemaFormPlan): unknown {
  return projectAnswer(plan, seedDraftFromPlan(plan));
}

describe("what a drawn form opens holding", () => {
  it("seeds nothing at all for a schema answered as raw JSON", () => {
    // The raw arm has no controls, so there is nothing for a seed to be visible in —
    // and its document is the person's, which nothing here writes into.
    expect(openingAnswer(planSchemaForm({ type: "string" }))).toEqual({});
  });

  it("opens a REQUIRED collection at the empty list its control already renders", () => {
    const plan = planSchemaForm({
      type: "object",
      properties: { reviewers: { type: "array", items: { type: "string" } } },
      required: ["reviewers"],
    });

    // The collection must exist, and an empty list is what its fieldset is already
    // drawing. Omitted, a required array that legally accepts zero entries opened invalid
    // and could not be submitted until somebody added an entry and removed it again.
    expect(openingAnswer(plan)).toEqual({ reviewers: [] });
  });

  it("opens an OPTIONAL collection absent, so a presence-sensitive schema is answerable", () => {
    const plan = planSchemaForm({
      type: "object",
      properties: { reviewers: { type: "array", items: { type: "string" }, minItems: 1 } },
    });

    // A collection the answer may leave out, which this schema then refuses to accept
    // EMPTY. Seeded `[]`, the form opened invalid on a collection nobody had added to, and
    // the only state that cleared it was answering a question the schema had not asked.
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

    // Every member of the group is optional, so no leaf contributes a value — and the
    // group is still required. Left to its leaves, the answer held no `release` at all,
    // the form offered no way to create the empty object the schema accepts, and typing
    // and clearing `tag` produced `{ release: { tag: "" } }` instead.
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

    // The shape the group seed could not answer. `enabled` is required INSIDE `settings`,
    // so seeding each member on its own requiredness opened `{ settings: { enabled: false
    // } }` — and a box can only replace that with true or false, so a schema that accepts
    // or requires the whole group to be ABSENT had no state the drawn form could reach.
    // The group opens inactive; somebody activates it on its legend.
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

    // The mapper never draws this collection at all — a declared value its control could
    // not show sends the whole schema to the raw editor — so there is no control here for
    // "ada" to be invisible in, and the seed is the raw arm's empty one.
    expect(openingAnswer(plan)).toEqual({});
  });

  it("seeds nothing a control could not display, whatever the schema declared", () => {
    const plan = planSchemaForm({
      type: "object",
      properties: { retries: { type: "number", default: "auto" } },
    });

    // Seeded, "auto" reached the submission while `SchemaNumberField` rendered a blank
    // box: the answer carrying text nobody had seen or could clear.
    expect(openingAnswer(plan)).toEqual({});
  });

  it("seeds nothing for an enumerated default the choice control could not offer", () => {
    const plan = planSchemaForm({
      type: "object",
      properties: { severity: { type: "string", enum: ["low", "high"], default: "retired" } },
    });

    // Seeded, "retired" reached the submission while the select showed "Not answered":
    // the answer carrying a member the control on the screen was not displaying.
    expect(openingAnswer(plan)).toEqual({});
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

    // Dropped, the `tag` control opened blank while the schema's own reading of `{}` was
    // `{ release: { tag: "v1" } }` — so the form read valid and a press sent bytes
    // different from the value that was accepted.
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

    // The nearest declared value on the path, which is the control's own.
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
          // Required, so the box is the control this member draws through and `false` is
          // the state it is already showing. Optional, the same member is a three-state
          // choice that opens absent, which is a different case and is pinned above.
          required: ["signed"],
        },
      },
    });

    // An empty declared value names nothing, so each control opens where it would have
    // anyway — which for the box is the `false` it is already showing.
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
      evidence: { type: "array", items: { type: "string", format: "artifact" } },
    },
  };

  it("opens a repeated entry at the value its item schema declared", () => {
    expect(newListEntryDraft(planSchemaForm(listSchema), ["flags"])).toEqual(answeredScalar(true));
  });

  it("opens a repeated entry with nothing declared as the empty text a control shows", () => {
    expect(newListEntryDraft(planSchemaForm(listSchema), ["names"])).toEqual(answeredScalar(""));
  });

  it("opens a repeated number unanswered rather than as the empty string", () => {
    // A number control shows nothing for a string, so `""` there is a payload holding a
    // value no control on the screen is displaying — and an UNANSWERED node rather than
    // `undefined`, which inside the answer's array serializes as `null`.
    expect(newListEntryDraft(planSchemaForm(listSchema), ["scores"])).toBe(UNANSWERED_SCALAR);
  });

  it("opens a repeated choice unanswered, including one whose enumeration spells empty", () => {
    // `""` is a member this enumeration legitimately contains, so inserting it would have
    // answered the question the moment somebody pressed the add control.
    expect(newListEntryDraft(planSchemaForm(listSchema), ["tiers"])).toBe(UNANSWERED_SCALAR);
  });

  it("opens a repeated artifact reference unanswered rather than as an empty identifier", () => {
    expect(newListEntryDraft(planSchemaForm(listSchema), ["evidence"])).toBe(UNANSWERED_SCALAR);
  });

  it("answers for a collection this form never drew rather than throwing", () => {
    // A caller asking about a member no control exists for is asking about a form it does
    // not have — which is a value question and never a crash, like every read here. There
    // is no control to derive an opening value from, so there is no value.
    expect(newListEntryDraft(planSchemaForm(listSchema), ["absent"])).toBeUndefined();
  });
});
