// What a form opens holding before anybody answers: declared values, the one state a control
// cannot leave blank, and collections that are an answer while empty. The defaulted schema is
// where the composed answer and the checked answer come apart, and a box has no unanswered
// state. Asserted over the hook, since what a press would send is not visible in the markup.

import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  answerMember,
  listValuesOf,
  memberValueOf,
  mountForm,
  NESTED_SCHEMA,
} from "./useSchemaForm.test-support.js";
import { isSameMemberPath } from "../schema-member-path.js";

afterEach(cleanup);

/** A schema that fills one member in for itself and leaves the other to a person. */
const DEFAULTED_SCHEMA = {
  type: "object",
  properties: { approver: { type: "string", default: "ada" }, note: { type: "string" } },
  required: ["approver"],
} as const;

/** A schema that fills one member in for itself while requiring one it does not. */
const PARTLY_DEFAULTED_SCHEMA = {
  type: "object",
  properties: { approver: { type: "string", default: "ada" }, note: { type: "string" } },
  required: ["note"],
} as const;

/**
 * A schema that accepts an optional yes-or-no only as a yes, or not at all: a two-state box
 * would open on the refused value. It uses `const` rather than `not: { required }` because
 * the schema reader this console admits throws on `not`, which sends that schema to the raw
 * editor and never a drawn control.
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
    // The reader supplies a member that declares a default, so `{}` is valid; sending `{}`
    // beside a blank control would put a clean verdict next to bytes nobody chose.
    const form = await mountForm(DEFAULTED_SCHEMA);

    expect(form().report?.status).toBe("valid");
    expect(form().answer).toEqual({ approver: "ada" });
    // The seed shows on the control, not only on the wire.
    expect(memberValueOf(form(), ["approver"])).toBe("ada");
  });

  it("negative control: a member the schema declares no value for opens empty", async () => {
    // Guards the case above against a form that pre-fills every control with something.
    const form = await mountForm(DEFAULTED_SCHEMA);

    expect(memberValueOf(form(), ["note"])).toBeUndefined();
  });

  it("carries a typed answer over the schema's own value for that member", async () => {
    // A seed is a starting value: answering the member replaces it.
    const form = await mountForm(DEFAULTED_SCHEMA);

    act(() => {
      answerMember(form(), ["approver"], "bela");
    });

    expect(form().answer).toEqual({ approver: "bela" });
  });

  it("seeds a member's own default while a different member is still unanswered", async () => {
    // `{}` is refused because `note` is missing, yet `approver`'s declared value must still
    // seed its control rather than reappear only once the other member is answered.
    const form = await mountForm(PARTLY_DEFAULTED_SCHEMA);

    expect(form().report?.status).toBe("invalid");
    expect(memberValueOf(form(), ["approver"])).toBe("ada");
    expect(form().answer).toEqual({ approver: "ada" });
  });

  it("negative control: the answer holds no member the controls are not showing", async () => {
    // Asserted over the answer: every member a submission carries is readable from a control.
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
    // An unchecked box says no, so submitting at once carries `false`, not nothing.
    const form = await mountForm(REQUIRED_BOOLEAN_SCHEMA);

    expect(memberValueOf(form(), ["approved"])).toBe(false);
    expect(form().answer).toEqual({ approved: false });
    expect(form().report?.status).toBe("valid");
  });

  it("opens an optional yes-or-no unanswered, so a presence-sensitive schema is answerable", async () => {
    // A box writes `true` or `false`, never "not answered", so seeding `false` would open the
    // form invalid on a member nobody touched.
    const form = await mountForm(PRESENCE_SENSITIVE_SCHEMA);

    expect(form().answer).toEqual({});
    expect(form().report?.status).toBe("valid");
  });

  it("writes the yes-or-no a person picks, which is what makes the third state an answer", async () => {
    // Negative control for the case above: a control that only ever reported nothing would pass.
    const form = await mountForm(PRESENCE_SENSITIVE_SCHEMA);

    act(() => {
      answerMember(form(), ["notify"], true);
    });

    expect(form().answer).toEqual({ notify: true });
    expect(form().report?.status).toBe("valid");
  });

  it("answers a schema the reader cannot compile as JSON rather than in a control it drew", async () => {
    // Measured: the admitted reader throws on `not`, so that schema is answered in the raw
    // editor, which is why the cases above use a schema this console draws.
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
    // The seed is the declared values plus the one state a box cannot leave blank, never a
    // value invented for every control (`note: ""`).
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

    // The number box is blank, so the answer holds no value, and the schema reports the entry.
    expect(listValuesOf(form(), ["scores"])).toEqual([undefined]);
    expect(form().report?.status).toBe("invalid");
    expect(
      form().report?.issues.some((issue) => isSameMemberPath(issue.memberPath, ["scores", 0])),
    ).toBe(true);
  });

  it("answers a required collection that accepts none with the empty list it is showing", async () => {
    // A required array satisfied by zero entries must open valid, not only after adding an
    // entry and removing it.
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

    // Read off the control too: a submitted value must be visible in the control it belongs to.
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
