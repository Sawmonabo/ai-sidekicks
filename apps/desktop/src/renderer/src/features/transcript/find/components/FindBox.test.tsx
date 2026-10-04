// The find field. The counter's denominator is the walkable set, not the uncapped total.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FindBox } from "./FindBox.js";
import { findInTranscript, type FindResult } from "../find-model.js";
import { runRow } from "../../transcript-event-rows.test-support.js";

/** More matches than the three-row window below can walk, so the cap arm is real. */
const UNCAPPED_TOTAL = 940;

function matchingResult(): FindResult {
  return findInTranscript(
    [
      runRow({
        id: "r1",
        sequence: 1,
        type: "run.running",
        runId: "run-a",
        position: 1,
        summary: "hit one",
      }),
      runRow({
        id: "r2",
        sequence: 2,
        type: "run.running",
        runId: "run-a",
        position: 2,
        summary: "hit two",
      }),
      runRow({
        id: "r3",
        sequence: 3,
        type: "run.running",
        runId: "run-a",
        position: 3,
        summary: "hit three",
      }),
    ],
    "hit",
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
      currentMatchIndex={options.currentMatchIndex ?? -1}
      openRequestCount={options.openRequestCount ?? 1}
      onQueryChange={(query) => acts.push(`query:${query}`)}
      onStep={(direction) => acts.push(`step:${direction}`)}
      onClose={() => acts.push("close")}
    />,
  );
  return {
    field: screen.getByRole("search"),
    acts,
    input: screen.getByRole("searchbox", { name: "Find in this session" }),
  };
}

describe("find field — the counter is the app's own reading", () => {
  it("names the walkable set as the denominator when the walk is capped", () => {
    // The denominator is the set the walk can reach; the uncapped total would advertise matches
    // no step lands on.
    const capped: FindResult = { ...matchingResult(), totalMatchCount: UNCAPPED_TOTAL };
    const { field } = renderField({ result: capped, currentMatchIndex: 0 });
    expect(field.textContent).toContain("1 of 3");
    expect(field.textContent).not.toContain(`1 of ${String(UNCAPPED_TOTAL)}`);
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
