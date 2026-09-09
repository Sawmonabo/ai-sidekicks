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

import {
  answerListEntry,
  answerMember,
  listValuesOf,
  memberValueOf,
  mountForm,
  NESTED_SCHEMA,
} from "./use-schema-form.test-support.js";
import { unansweredScalar } from "../answer/schema-draft.js";
import { isSameMemberPath } from "../../../bridge/index.js";

afterEach(cleanup);

describe("the schema form's state", () => {
  it("writes a top-level member into the answer", async () => {
    const form = await mountForm(NESTED_SCHEMA);

    act(() => {
      answerMember(form(), ["title"], "Ship it");
    });

    expect(memberValueOf(form(), ["title"])).toBe("Ship it");
    // `reviewers` is OPTIONAL here, so it is absent until somebody adds an entry: an empty
    // collection and one nobody has added to look identical on the screen, and the rule
    // that tells them apart in the answer is the schema's own requiredness.
    expect(form().answer).toEqual({ title: "Ship it" });
  });

  it("writes a member one level down without disturbing its siblings", async () => {
    const form = await mountForm(NESTED_SCHEMA);

    act(() => {
      answerMember(form(), ["title"], "Ship it");
    });
    act(() => {
      answerMember(form(), ["release", "tag"], "v2");
    });

    expect(form().answer).toEqual({ title: "Ship it", release: { tag: "v2" } });
  });

  it("keeps a list in order when an entry leaves the middle of it", async () => {
    const form = await mountForm(NESTED_SCHEMA);

    for (const name of ["ada", "bela", "cyd"]) {
      act(() => {
        form().appendListEntry(["reviewers"]);
      });
      act(() => {
        answerListEntry(
          form(),
          ["reviewers"],
          listValuesOf(form(), ["reviewers"]).length - 1,
          name,
        );
      });
    }
    act(() => {
      form().removeListEntry(["reviewers"], 1);
    });

    expect(listValuesOf(form(), ["reviewers"])).toEqual(["ada", "cyd"]);
  });

  it("reads the schema's verdict on the drawn answer and clears it once the answer is whole", async () => {
    const form = await mountForm(NESTED_SCHEMA);

    expect(form().report?.status).toBe("invalid");
    expect(
      form().report?.issues.some((issue) => isSameMemberPath(issue.memberPath, ["title"])),
    ).toBe(true);

    act(() => {
      answerMember(form(), ["title"], "Ship it");
    });
    act(() => {
      answerMember(form(), ["release", "tag"], "v2");
    });

    expect(form().report?.status).toBe("valid");
  });

  it("returns an optional collection to absent on the control that answers it, not on an empty one", async () => {
    // The other half of opening absent, and the half a row count cannot give. Read off the
    // rows, `[]` and absent were one display, so a schema that tells them apart had a state
    // the form could not compose; read off the LATCH they are two, and the way back out is
    // the control on the legend. This schema will not accept an empty `reviewers` and will
    // accept none at all, so both readings are in the VERDICT and not only in the shape.
    const form = await mountForm({
      type: "object",
      properties: { reviewers: { type: "array", items: { type: "string" }, minItems: 1 } },
    });

    expect(form().report?.status).toBe("valid");
    expect(form().listIsActive(["reviewers"])).toBe(false);

    act(() => {
      form().setListActive(["reviewers"], true);
    });
    act(() => {
      form().appendListEntry(["reviewers"]);
    });
    expect(form().answer).toHaveProperty("reviewers");

    act(() => {
      form().removeListEntry(["reviewers"], 0);
    });

    // Present and empty: somebody is answering this collection and it holds nothing, which
    // is the state `minItems: 1` refuses and the state an absent member is not.
    expect(form().answer).toEqual({ reviewers: [] });
    expect(form().report?.status).toBe("invalid");

    act(() => {
      form().setListActive(["reviewers"], false);
    });

    expect(form().answer).not.toHaveProperty("reviewers");
    expect(form().report?.status).toBe("valid");
  });

  it("negative control: a REQUIRED collection stays at the empty list it is drawing", async () => {
    const form = await mountForm({
      type: "object",
      properties: { reviewers: { type: "array", items: { type: "string" } } },
      required: ["reviewers"],
    });

    act(() => {
      form().appendListEntry(["reviewers"]);
    });
    act(() => {
      form().removeListEntry(["reviewers"], 0);
    });

    expect(form().answer).toEqual({ reviewers: [] });
  });

  it("opens an optional group unanswered, and takes it back out when it is left unanswered", async () => {
    // The same claim as before the draft tree — an optional group can be absent from the
    // answer, and a person can get it back there — moved onto the control that now says
    // so. `release` is optional here and holds a REQUIRED `tag`, which is the shape that
    // made the old rule unreachable: seeded through its children, the group opened present
    // and no control on the form could remove it.
    const form = await mountForm(NESTED_SCHEMA);

    expect(form().answer).not.toHaveProperty("release");
    expect(form().groupIsActive(["release"])).toBe(false);

    act(() => {
      form().setGroupActive(["release"], true);
    });
    act(() => {
      answerMember(form(), ["release", "tag"], "v2");
    });
    expect(form().answer).toHaveProperty("release");

    act(() => {
      form().setGroupActive(["release"], false);
    });

    expect(form().answer).not.toHaveProperty("release");
  });

  it("keeps a row with nothing in it out of the answer and names it instead", async () => {
    // The representation's whole point. An added number entry nobody has answered was
    // `undefined` inside the answer's array, which `JSON.stringify` writes as `null`: the
    // validator checked one value, the daemon would have received another, and the blank
    // control displayed neither. The row is now a draft node the answer never carries.
    const form = await mountForm({
      type: "object",
      properties: { scores: { type: "array", items: { type: "number" } } },
    });

    act(() => {
      form().appendListEntry(["scores"]);
    });

    const answer = form().answer;
    expect(JSON.parse(JSON.stringify(answer))).toEqual(answer);
    // The collection is present — adding a row is answering it — and the row itself is not
    // in the array, which is the whole claim: no position serializes to `null`.
    expect(answer).toEqual({ scores: [] });
    expect(form().report?.status).toBe("invalid");
    expect(form().listEntryIssues(["scores"], 0)).toEqual(["Entry 1 has no value yet."]);
    expect(listValuesOf(form(), ["scores"])).toEqual([undefined]);
  });

  it("keeps an unreadable figure on the row it was typed into when an earlier row leaves", async () => {
    // Keyed by index, the control state holding `1e309` followed the POSITION: removing an
    // earlier entry moved the text to whichever row inherited the reused subtree. It lives
    // on the entry node now, so it travels with its own entry.
    const form = await mountForm({
      type: "object",
      properties: { scores: { type: "array", items: { type: "number" } } },
    });

    for (const _row of [0, 1, 2]) {
      act(() => {
        form().appendListEntry(["scores"]);
      });
    }
    act(() => {
      form().setListEntryDraft(["scores"], 2, unansweredScalar("1e309"));
    });
    const thirdEntryId = form().listEntries(["scores"])[2]?.entryId;

    act(() => {
      form().removeListEntry(["scores"], 0);
    });

    const remaining = form().listEntries(["scores"]);
    expect(remaining).toHaveLength(2);
    expect(remaining[1]?.entryId).toBe(thirdEntryId);
    expect(remaining[1]?.unreadableText).toBe("1e309");
    expect(remaining[0]?.unreadableText).toBe("");
  });

  it("negative control: a REQUIRED group is answered from the mount and stays as `{}`", async () => {
    const form = await mountForm({
      type: "object",
      properties: { release: { type: "object", properties: { tag: { type: "string" } } } },
      required: ["release"],
    });

    act(() => {
      answerMember(form(), ["release", "tag"], "v2");
    });
    act(() => {
      answerMember(form(), ["release", "tag"], undefined);
    });

    expect(form().answer).toEqual({ release: {} });
  });

  it("reads the answer off the raw text when the schema drew no controls", async () => {
    const form = await mountForm({ type: "string" });

    expect(form().plan.shape).toBe("raw");

    act(() => {
      form().setRawText('{"anything": 1}');
    });

    expect(form().rawReading).toEqual({ status: "parsed", answer: { anything: 1 } });
    expect(form().answer).toEqual({ anything: 1 });
  });

  it("reports unparsable raw text as a syntax reading rather than as an answer", async () => {
    const form = await mountForm({ type: "string" });

    act(() => {
      form().setRawText("{not json");
    });

    expect(form().rawReading.status).toBe("unparsable");
    expect(form().answer).toBeUndefined();
    // No verdict at all, because there is nothing to check yet — and never a verdict of
    // `valid`, which would say the answer satisfied a schema it was never handed to.
    expect(form().report).toBeUndefined();
  });

  it("holds no verdict at all when the schema itself could not be compiled", async () => {
    const form = await mountForm({
      type: "object",
      properties: { a: { $ref: "#/definitions/x" } },
    });

    expect(form().validator.status).toBe("uncompilable");
    expect(form().report).toBeUndefined();
  });

  it("reads the answer off the raw text when the drawable schema compiled nowhere", async () => {
    // The mapper is happy with this member; the schema READER refuses the root. An arm
    // chosen from the mapper alone drew controls whose answer nothing would ever check —
    // so what this pins is where the answer COMES FROM, which is the half a test of the
    // drawn markup cannot reach.
    const form = await mountForm({
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
