// The state one form holds: where a value lands, what a list does when an entry leaves, and a
// row with nothing in it. Removing the middle of three entries renumbers the answer, since an
// entry's name is its position.

import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  answerListEntry,
  answerMember,
  listValuesOf,
  mountForm,
  NESTED_SCHEMA,
} from "./useSchemaForm.test-support.js";

afterEach(cleanup);

describe("the schema form's state", () => {
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

  it("keeps a row with nothing in it out of the answer and names it instead", async () => {
    // An unanswered number entry must not sit in the array as `undefined`, which
    // `JSON.stringify` writes as `null`: the validator and the wire would see different values.
    const form = await mountForm({
      type: "object",
      properties: { scores: { type: "array", items: { type: "number" } } },
    });

    act(() => {
      form().appendListEntry(["scores"]);
    });

    const answer = form().answer;
    expect(JSON.parse(JSON.stringify(answer))).toEqual(answer);
    // The collection is present (adding a row answers it) and the row is not in the array.
    expect(answer).toEqual({ scores: [] });
    expect(form().report?.status).toBe("invalid");
    expect(form().listEntryIssues(["scores"], 0)).toEqual(["Entry 1 has no value yet."]);
    expect(listValuesOf(form(), ["scores"])).toEqual([undefined]);
  });
});
