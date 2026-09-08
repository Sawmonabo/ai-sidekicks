// The state one form holds: where a value lands, what a list does when an entry leaves,
// and which of the two input modes the answer is read from.
//
// The list case is the one worth writing down. Removing the middle entry of three has to
// renumber the answer, because the entries are positions and the position is the name —
// a hole left at index one would leave the third entry called "3" while the answer carried
// it second, and the schema would then report a finding against a control nobody is
// looking at.
//
// WHAT A FORM OPENS HOLDING IS `use-schema-form.opening.test.tsx`. Split because the two
// are different claims — what an edit does to the answer, and what the answer already says
// before anybody has made one — and one file holding both had grown past what a reader can
// hold at once. The mount both drive through is `use-schema-form.test-support.tsx`.

import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { mountForm, NESTED_SCHEMA } from "./use-schema-form.test-support.js";
import { isSameMemberPath } from "../../bridge/index.js";

afterEach(cleanup);

describe("the schema form's state", () => {
  it("writes a top-level member into the answer", () => {
    const form = mountForm(NESTED_SCHEMA);

    act(() => {
      form().setMemberValue(["title"], "Ship it");
    });

    expect(form().memberValue(["title"])).toBe("Ship it");
    // The drawn collection is in the answer from the mount, because it is on the screen
    // from the mount: an empty list is what its control is already showing.
    expect(form().answer).toEqual({ title: "Ship it", reviewers: [] });
  });

  it("writes a member one level down without disturbing its siblings", () => {
    const form = mountForm(NESTED_SCHEMA);

    act(() => {
      form().setMemberValue(["title"], "Ship it");
    });
    act(() => {
      form().setMemberValue(["release", "tag"], "v2");
    });

    expect(form().answer).toEqual({ title: "Ship it", release: { tag: "v2" }, reviewers: [] });
  });

  it("keeps a list in order when an entry leaves the middle of it", () => {
    const form = mountForm(NESTED_SCHEMA);

    for (const name of ["ada", "bela", "cyd"]) {
      act(() => {
        form().appendListItem(["reviewers"]);
      });
      act(() => {
        form().setListItem(["reviewers"], form().listItems(["reviewers"]).length - 1, name);
      });
    }
    act(() => {
      form().removeListItem(["reviewers"], 1);
    });

    expect(form().listItems(["reviewers"])).toEqual(["ada", "cyd"]);
  });

  it("reads the schema's verdict on the drawn answer and clears it once the answer is whole", () => {
    const form = mountForm(NESTED_SCHEMA);

    expect(form().report?.status).toBe("invalid");
    expect(
      form().report?.issues.some((issue) => isSameMemberPath(issue.memberPath, ["title"])),
    ).toBe(true);

    act(() => {
      form().setMemberValue(["title"], "Ship it");
    });
    act(() => {
      form().setMemberValue(["release", "tag"], "v2");
    });

    expect(form().report?.status).toBe("valid");
  });

  it("reads the answer off the raw text when the schema drew no controls", () => {
    const form = mountForm({ type: "string" });

    expect(form().plan.shape).toBe("raw");

    act(() => {
      form().setRawText('{"anything": 1}');
    });

    expect(form().rawReading).toEqual({ status: "parsed", answer: { anything: 1 } });
    expect(form().answer).toEqual({ anything: 1 });
  });

  it("reports unparsable raw text as a syntax reading rather than as an answer", () => {
    const form = mountForm({ type: "string" });

    act(() => {
      form().setRawText("{not json");
    });

    expect(form().rawReading.status).toBe("unparsable");
    expect(form().answer).toBeUndefined();
    // No verdict at all, because there is nothing to check yet — and never a verdict of
    // `valid`, which would say the answer satisfied a schema it was never handed to.
    expect(form().report).toBeUndefined();
  });

  it("holds no verdict at all when the schema itself could not be compiled", () => {
    const form = mountForm({ type: "object", properties: { a: { $ref: "#/definitions/x" } } });

    expect(form().validator.status).toBe("uncompilable");
    expect(form().report).toBeUndefined();
  });

  it("reads the answer off the raw text when the drawable schema compiled nowhere", () => {
    // The mapper is happy with this member; the schema READER refuses the root. An arm
    // chosen from the mapper alone drew controls whose answer nothing would ever check —
    // so what this pins is where the answer COMES FROM, which is the half a test of the
    // drawn markup cannot reach.
    const form = mountForm({
      type: "object",
      properties: { title: { type: "string" } },
      if: { properties: { title: { const: "urgent" } } },
      then: { required: ["title"] },
    });
    const plan = form().plan;

    expect(form().validator.status).toBe("uncompilable");
    expect(plan.shape === "raw" ? plan.fallback.cause : undefined).toBe("schema-uncheckable");

    act(() => {
      form().setRawText('{"title": "Ship it"}');
    });

    expect(form().answer).toEqual({ title: "Ship it" });
  });
});
