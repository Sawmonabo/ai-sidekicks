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
    // `reviewers` is OPTIONAL here, so it is absent until somebody adds an entry: an empty
    // collection and one nobody has added to look identical on the screen, and the rule
    // that tells them apart in the answer is the schema's own requiredness.
    expect(form().answer).toEqual({ title: "Ship it" });
  });

  it("writes a member one level down without disturbing its siblings", () => {
    const form = mountForm(NESTED_SCHEMA);

    act(() => {
      form().setMemberValue(["title"], "Ship it");
    });
    act(() => {
      form().setMemberValue(["release", "tag"], "v2");
    });

    expect(form().answer).toEqual({ title: "Ship it", release: { tag: "v2" } });
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

  it("returns an optional collection to absent when its last entry is removed", () => {
    // The other half of opening absent, and the half a seed cannot give: `[]` left behind
    // by an add-then-remove is a member the form put there and offered no way to take
    // away. This schema will not accept an empty `reviewers` and will accept none at all,
    // so the round trip is readable in the VERDICT and not only in the answer's shape.
    const form = mountForm({
      type: "object",
      properties: { reviewers: { type: "array", items: { type: "string" }, minItems: 1 } },
    });

    expect(form().report?.status).toBe("valid");
    act(() => {
      form().appendListItem(["reviewers"]);
    });
    expect(form().answer).toHaveProperty("reviewers");

    act(() => {
      form().removeListItem(["reviewers"], 0);
    });

    expect(form().answer).not.toHaveProperty("reviewers");
    expect(form().report?.status).toBe("valid");
  });

  it("negative control: a REQUIRED collection stays at the empty list it is drawing", () => {
    const form = mountForm({
      type: "object",
      properties: { reviewers: { type: "array", items: { type: "string" } } },
      required: ["reviewers"],
    });

    act(() => {
      form().appendListItem(["reviewers"]);
    });
    act(() => {
      form().removeListItem(["reviewers"], 0);
    });

    expect(form().answer).toEqual({ reviewers: [] });
  });

  it("takes an optional group out of the answer when its last answered member clears", () => {
    // A group is a member like any other: `release` is optional here, so an answer holding
    // `{ release: {} }` after somebody withdrew the only thing they had typed into it is a
    // member nothing on the screen accounts for.
    const form = mountForm(NESTED_SCHEMA);

    act(() => {
      form().setMemberValue(["release", "tag"], "v2");
    });
    expect(form().answer).toHaveProperty("release");

    act(() => {
      form().setMemberValue(["release", "tag"], undefined);
    });

    expect(form().answer).not.toHaveProperty("release");
  });

  it("negative control: a REQUIRED group stays at the empty object it is standing over", () => {
    const form = mountForm({
      type: "object",
      properties: { release: { type: "object", properties: { tag: { type: "string" } } } },
      required: ["release"],
    });

    act(() => {
      form().setMemberValue(["release", "tag"], "v2");
    });
    act(() => {
      form().setMemberValue(["release", "tag"], undefined);
    });

    expect(form().answer).toEqual({ release: {} });
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
