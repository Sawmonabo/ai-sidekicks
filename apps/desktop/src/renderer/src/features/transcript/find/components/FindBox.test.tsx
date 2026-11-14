// The find field. The counter's denominator is every match the rows hold, and the walk reaches
// each of them.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LiveAnnouncerProvider } from "#renderer/components/LiveAnnouncer/LiveAnnouncerProvider.js";
import { liveRegionText } from "#test/helpers/live-region.js";
import { FindBox } from "./FindBox.js";
import {
  FIND_MATCH_CAP,
  FindMatchList,
  findInTranscript,
  stepFindMatch,
  type FindMatch,
  type FindResult,
  type FindStepDirection,
} from "../matcher.js";
import { userMessageRow } from "../../event-rows.test-support.js";

function matchingResult(): FindResult {
  return findInTranscript(
    [
      userMessageRow({ id: "r1", sequence: 1, message: "hit one" }),
      userMessageRow({ id: "r2", sequence: 2, message: "hit two" }),
      userMessageRow({ id: "r3", sequence: 3, message: "hit three" }),
    ],
    "hit",
    new Map(),
  );
}

interface FindHarness {
  readonly field: HTMLElement;
  readonly acts: readonly string[];
  readonly input: HTMLInputElement;
}

function renderField(
  options: {
    readonly result?: FindResult;
    readonly query?: string;
    readonly currentMatchIndex?: number;
    /** How many times the caller has asked for the field. One, unless a case re-opens it. */
    readonly openRequestCount?: number;
  } = {},
): FindHarness {
  const acts: string[] = [];
  const result = options.result ?? matchingResult();
  render(
    <FindBox
      query={options.query ?? result.query}
      result={result}
      areRowsShown
      currentMatchIndex={options.currentMatchIndex ?? -1}
      openRequestCount={options.openRequestCount ?? 1}
      onQueryChange={(query) => acts.push(`query:${query}`)}
      onStep={(direction) => acts.push(`step:${direction}`)}
      onClose={() => acts.push("close")}
    />,
    { wrapper: LiveAnnouncerProvider },
  );
  return {
    field: screen.getByRole("search"),
    acts,
    input: screen.getByRole("searchbox", { name: "Find in this session" }),
  };
}

describe("find field — the count and the walk reach every match", () => {
  it("counts every match and steps on past the matches one result holds, wrapping", () => {
    // More matches than one result holds, so the walk must move what it holds to go on.
    const matchCount = FIND_MATCH_CAP + 5;
    const rows = Array.from({ length: matchCount }, (_unused, index) =>
      userMessageRow({ id: `row-${String(index)}`, sequence: index + 1, message: "hit" }),
    );
    const matchList = new FindMatchList();
    let selected: FindMatch | undefined;
    const walkedRowIds: string[] = [];
    const step = (direction: FindStepDirection): ReturnType<typeof stepFindMatch> => {
      const result = matchList.resultOf(rows, "hit", new Map(), selected);
      const stepped = stepFindMatch(result, selected, direction);
      selected = stepped?.match;
      return stepped;
    };
    for (let walked = 0; walked < matchCount; walked += 1) {
      walkedRowIds.push(step("next")?.match.rowId ?? "none");
    }
    expect(walkedRowIds).toStrictEqual(rows.map((row) => row.id));
    expect(step("next")?.match.rowId).toBe("row-0");
    expect(step("previous")?.index).toBe(matchCount - 1);
    // From the last match a fresh search holds, the next is the one after it.
    const freshList = new FindMatchList();
    const lastHeld = freshList.resultOf(rows, "hit", new Map()).matches.at(-1);
    expect(lastHeld?.rowId).toBe(`row-${String(FIND_MATCH_CAP - 1)}`);
    const past = stepFindMatch(
      freshList.resultOf(rows, "hit", new Map(), lastHeld),
      lastHeld,
      "next",
    );
    expect(past?.match.rowId).toBe(`row-${String(FIND_MATCH_CAP)}`);

    const { field } = renderField({
      result: freshList.resultOf(rows, "hit", new Map(), past?.match),
      currentMatchIndex: past?.index ?? -1,
    });
    expect(field.textContent).toContain(`${String(FIND_MATCH_CAP + 1)} of ${String(matchCount)}`);
    expect(liveRegionText(document.body, "polite")).toBe(
      `${String(FIND_MATCH_CAP + 1)} of ${String(matchCount)}`,
    );
  });
});

describe("find field — the walk", () => {
  it("steps forward on Enter and back on Shift+Enter", () => {
    const harness = renderField();
    fireEvent.keyDown(harness.input, { key: "Enter" });
    fireEvent.keyDown(harness.input, { key: "Enter", shiftKey: true });
    expect(harness.acts).toStrictEqual(["step:next", "step:previous"]);
  });
});

describe("find field — the query and the close", () => {
  it("renders the query it was given, and not the one the matcher trimmed", () => {
    // The field shows what was typed; `result.query` is the trimmed form. Conflating them would
    // delete a trailing space under the cursor.
    const harness = renderField({ query: "hit " });
    expect(harness.input.value).toBe("hit ");
  });
});
