// What a form OPENS holding, before anybody has answered anything: the values its schema
// declared, the one state a control cannot leave blank, and the collections that are an
// answer while they are empty.
//
// THE DEFAULTED SCHEMA IS THE CASE THIS FILE EXISTS FOR. A member the schema fills in for
// itself is where the composed answer and the checked answer come apart: the cases over it
// pin that the value sent is the one the schema accepted, that the control shows it, and
// that answering the member replaces it rather than the other way round.
//
// AND THE YES-OR-NO IS THE OTHER. A box has no unanswered state, so a member drawn as one
// opens at the `false` it is already showing — and a boolean the answer may leave out is
// therefore not drawn as one, which is what makes a presence-sensitive schema answerable
// at all. Both halves are asserted here, over the hook rather than over the markup,
// because what a press would SEND is the half a rendered control cannot show.
//
// The state a form holds once somebody edits it is `use-schema-form.test.tsx`, and the
// mount both drive through is `use-schema-form.test-support.tsx`.

import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  answerMember,
  listValuesOf,
  memberValueOf,
  mountForm,
  NESTED_SCHEMA,
} from "./use-schema-form.test-support.js";
import { isSameMemberPath } from "../../../bridge/index.js";

afterEach(cleanup);

/** A schema that fills one member in for itself, and leaves the other to a person. */
const DEFAULTED_SCHEMA = {
  type: "object",
  properties: { approver: { type: "string", default: "ada" }, note: { type: "string" } },
  required: ["approver"],
} as const;

/** A schema that fills one member in for itself while REQUIRING one it does not. */
const PARTLY_DEFAULTED_SCHEMA = {
  type: "object",
  properties: { approver: { type: "string", default: "ada" }, note: { type: "string" } },
  required: ["note"],
} as const;

/**
 * A schema that accepts an optional yes-or-no ONLY as a yes, or not at all.
 *
 * The shape a two-state box cannot answer: `{}` and `{ notify: true }` are what it takes,
 * and a control whose only states are `true` and `false` opens on the one value it
 * refuses — invalid on a member nobody has touched, and clearable only by answering.
 *
 * `const` rather than the `not: { required: [...] }` the same defect was reported against,
 * for a measured reason pinned below: the schema reader `Spec-023 §Console Libraries`
 * admits throws on `not`, so that schema reaches the raw editor and never a drawn control
 * at all. The defect is the seed's, and this is a schema this console actually draws.
 */
const PRESENCE_SENSITIVE_SCHEMA = {
  type: "object",
  properties: { notify: { type: "boolean", title: "Notify", const: true } },
} as const;

/** A schema asking one mandatory yes-or-no and declaring no value for it. */
const REQUIRED_BOOLEAN_SCHEMA = {
  type: "object",
  properties: { approved: { type: "boolean", title: "Approved" } },
  required: ["approved"],
} as const;

describe("what a schema form opens holding", () => {
  it("submits the value the schema accepted, and opens its controls holding it", async () => {
    // The divergence this closes: the reader supplies a member declaring a default, so
    // `{}` is valid — and a form that sent `{}` while showing a blank control would put
    // a clean verdict beside bytes nobody could see and nobody chose.
    const form = await mountForm(DEFAULTED_SCHEMA);

    expect(form().report?.status).toBe("valid");
    expect(form().answer).toEqual({ approver: "ada" });
    // And on the control, not only on the wire: the seed is what a person reads.
    expect(memberValueOf(form(), ["approver"])).toBe("ada");
  });

  it("negative control: a member the schema declares no value for opens empty", async () => {
    // Without this, the case above would hold over a form that pre-filled every control
    // with something — the seed has to be the schema's own reading and nothing else.
    const form = await mountForm(DEFAULTED_SCHEMA);

    expect(memberValueOf(form(), ["note"])).toBeUndefined();
  });

  it("carries a typed answer over the schema's own value for that member", async () => {
    // The other half of the seed: it is a starting value and never an override, so
    // answering the member replaces it rather than being replaced by it.
    const form = await mountForm(DEFAULTED_SCHEMA);

    act(() => {
      answerMember(form(), ["approver"], "bela");
    });

    expect(form().answer).toEqual({ approver: "bela" });
  });

  it("seeds a member's own default while a different member is still unanswered", async () => {
    // The all-or-nothing seed's failure: `{}` is refused because `note` is missing, so a
    // schema that DID declare a value for `approver` opened that control blank — and the
    // value reappeared in the submission the moment the unrelated member was answered.
    const form = await mountForm(PARTLY_DEFAULTED_SCHEMA);

    expect(form().report?.status).toBe("invalid");
    expect(memberValueOf(form(), ["approver"])).toBe("ada");
    expect(form().answer).toEqual({ approver: "ada" });
  });

  it("negative control: the answer holds no member the controls are not showing", async () => {
    // The property the seed exists for, asserted over the answer rather than over one
    // member: every member a submission would carry is readable from a control.
    const form = await mountForm(PARTLY_DEFAULTED_SCHEMA);

    act(() => {
      answerMember(form(), ["note"], "looks good");
    });

    expect(form().report?.status).toBe("valid");
    const answer = form().answer as Record<string, unknown>;
    for (const memberKey of Object.keys(answer)) {
      expect(memberValueOf(form(), [memberKey])).toEqual(answer[memberKey]);
    }
    expect(answer).toEqual({ approver: "ada", note: "looks good" });
  });

  it("answers a required yes-or-no with the false its box is already showing", async () => {
    // An unchecked box is not a blank one: it says no. Submitting immediately therefore
    // carries `false` rather than nothing, and expressing it costs no second toggle.
    const form = await mountForm(REQUIRED_BOOLEAN_SCHEMA);

    expect(memberValueOf(form(), ["approved"])).toBe(false);
    expect(form().answer).toEqual({ approved: false });
    expect(form().report?.status).toBe("valid");
  });

  it("opens an optional yes-or-no unanswered, so a presence-sensitive schema is answerable", async () => {
    // Seeded `false`, the drawn form opened INVALID on a member nobody had touched, and
    // the only state that cleared it was answering the question — a box can write `true`
    // or `false` and neither of them is "not answered".
    const form = await mountForm(PRESENCE_SENSITIVE_SCHEMA);

    expect(form().answer).toEqual({});
    expect(form().report?.status).toBe("valid");
  });

  it("writes the yes-or-no a person picks, which is what makes the third state an answer", async () => {
    // The negative control on the case above: a control that could only ever report
    // nothing would satisfy it while answering the question for nobody.
    const form = await mountForm(PRESENCE_SENSITIVE_SCHEMA);

    act(() => {
      answerMember(form(), ["notify"], true);
    });

    expect(form().answer).toEqual({ notify: true });
    expect(form().report?.status).toBe("valid");
  });

  it("answers a schema the reader cannot compile as JSON rather than in a control it drew", async () => {
    // Measured at the pin: the admitted reader throws on `not`, so the schema the seeding
    // defect was reported against never reaches a drawn control at all — it is answerable
    // in the editor, which is this subtree's whole rule and is why the cases above are
    // written over a schema this console draws.
    const form = await mountForm({
      type: "object",
      properties: { notify: { type: "boolean" } },
      not: { required: ["notify"] },
    });

    expect(form().plan.shape).toBe("raw");
    expect(form().validator.status).toBe("uncompilable");
  });

  it("opens a yes-or-no at the value its schema declared", async () => {
    const form = await mountForm({
      type: "object",
      properties: { approved: { type: "boolean", default: true } },
    });

    expect(memberValueOf(form(), ["approved"])).toBe(true);
    expect(form().answer).toEqual({ approved: true });
  });

  it("negative control: a text member the schema declares no value for stays absent", async () => {
    // The seed is the schema's declared values plus the one state a box cannot leave
    // blank — never a value invented for every control, which would submit `note: \"\"`
    // for a member nobody answered.
    const form = await mountForm(PARTLY_DEFAULTED_SCHEMA);

    expect(memberValueOf(form(), ["note"])).toBeUndefined();
    expect(form().answer).not.toHaveProperty("note");
  });

  it("adds a yes-or-no list entry as the false its box shows", async () => {
    const form = await mountForm({
      type: "object",
      properties: { flags: { type: "array", items: { type: "boolean" } } },
    });

    act(() => {
      form().appendListEntry(["flags"]);
    });

    expect(listValuesOf(form(), ["flags"])).toEqual([false]);
  });

  it("adds a repeated number entry the schema reads as unanswered rather than as text", async () => {
    const form = await mountForm({
      type: "object",
      properties: { scores: { type: "array", items: { type: "number" } } },
    });

    act(() => {
      form().appendListEntry(["scores"]);
    });

    // The control shows a blank number box, so the answer holds no value for it — and the
    // schema reports the entry rather than accepting a string the box cannot display.
    expect(listValuesOf(form(), ["scores"])).toEqual([undefined]);
    expect(form().report?.status).toBe("invalid");
    expect(
      form().report?.issues.some((issue) => isSameMemberPath(issue.memberPath, ["scores", 0])),
    ).toBe(true);
  });

  it("answers a required collection that accepts none with the empty list it is showing", async () => {
    // Before, the member was omitted while the control drew an empty collection, so a
    // required array legally satisfied by zero entries opened invalid and could only be
    // submitted by adding an entry and taking it away again.
    const form = await mountForm({
      type: "object",
      properties: { reviewers: { type: "array", items: { type: "string" } } },
      required: ["reviewers"],
    });

    expect(listValuesOf(form(), ["reviewers"])).toEqual([]);
    expect(form().answer).toEqual({ reviewers: [] });
    expect(form().report?.status).toBe("valid");
  });

  it("opens a control at the value its enclosing group declared for it", async () => {
    const form = await mountForm({
      type: "object",
      properties: {
        release: {
          type: "object",
          default: { tag: "v1" },
          properties: { tag: { type: "string" } },
        },
      },
    });

    // Read off the CONTROL and not only off the answer: the value reaches the submission
    // by being visible in the control it belongs to, which is this seed's whole rule.
    expect(memberValueOf(form(), ["release", "tag"])).toBe("v1");
    expect(form().answer).toEqual({ release: { tag: "v1" } });
  });

  it("negative control: a text list entry is still added empty rather than as false", async () => {
    const form = await mountForm(NESTED_SCHEMA);

    act(() => {
      form().appendListEntry(["reviewers"]);
    });

    expect(listValuesOf(form(), ["reviewers"])).toEqual([""]);
  });

  it("opens a member one level down at the value its own schema declared", async () => {
    const form = await mountForm({
      type: "object",
      properties: {
        release: { type: "object", properties: { tag: { type: "string", default: "v1" } } },
      },
    });

    expect(memberValueOf(form(), ["release", "tag"])).toBe("v1");
    expect(form().answer).toEqual({ release: { tag: "v1" } });
  });

  it("opens a list holding the entries its schema declared", async () => {
    const form = await mountForm({
      type: "object",
      properties: { reviewers: { type: "array", items: { type: "string" }, default: ["ada"] } },
    });

    expect(listValuesOf(form(), ["reviewers"])).toEqual(["ada"]);
    expect(form().answer).toEqual({ reviewers: ["ada"] });
  });
});
