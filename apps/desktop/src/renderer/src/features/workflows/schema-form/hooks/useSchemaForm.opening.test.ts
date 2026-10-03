// What a form opens holding before anybody answers: a declared value is both sent and shown, and
// the answer holds no member a control is not showing. The defaulted schema is where the composed
// answer and the checked answer come apart. Asserted over the hook, since what a press would send
// is not visible in the markup.

import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { answerMember, memberValueOf, mountForm } from "./useSchemaForm.test-support.js";

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

  it("carries only members a control is showing", async () => {
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
});
