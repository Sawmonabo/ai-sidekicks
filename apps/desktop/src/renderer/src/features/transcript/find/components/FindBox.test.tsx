// The find field.
//
// The counter is asserted from the side of the walk: the walkable set and the true
// total are different numbers, and the position is of the walkable one.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FindBox } from "./FindBox.js";
import { emptyFindResult, findInTranscript, type FindResult } from "../find-model.js";
import { runRow } from "../../timeline-rows.test-support.js";

/** More matches than the three-row window below can walk, so the cap arm is real. */
const UNCAPPED_TOTAL = 940;

/** Three rows, all matching "hit", so a query produces a walkable list. */
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

/** What a mounted field lets a case observe. */
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

describe("find field — the counter is the console's own reading", () => {
  it("reports how much was searched before anything is typed", () => {
    const { field } = renderField({ result: emptyFindResult(42), query: "" });
    expect(field.textContent).toContain("42 rows loaded");
  });

  it("names a position within the honest total", () => {
    const { field } = renderField({ currentMatchIndex: 1 });
    expect(field.textContent).toContain("2 of 3");
  });

  it("names the walkable set as the denominator when the walk is capped", () => {
    // The denominator is the set the next/previous walk can actually reach. It read
    // "1 of 940" over a three-match walk, so the walk wrapped at three while the
    // field advertised 940 and matches 4-940 were unreachable in silence.
    const capped: FindResult = { ...matchingResult(), totalMatchCount: UNCAPPED_TOTAL };
    const { field } = renderField({ result: capped, currentMatchIndex: 0 });
    expect(field.textContent).toContain("1 of 3");
    expect(field.textContent).not.toContain(`1 of ${String(UNCAPPED_TOTAL)}`);
  });

  it("negative control: with nothing found it says so", () => {
    const empty = findInTranscript([], "nothing here");
    const { field } = renderField({ result: empty, query: "nothing here" });
    expect(field.textContent).toContain("No matches");
  });
});

describe("find field — the walk", () => {
  it("steps forward on Enter and back on Shift+Enter", () => {
    const harness = renderField();
    fireEvent.keyDown(harness.input, { key: "Enter" });
    fireEvent.keyDown(harness.input, { key: "Enter", shiftKey: true });
    expect(harness.acts).toStrictEqual(["step:next", "step:previous"]);
  });

  it("negative control: an ordinary keystroke does not step the walk", () => {
    const harness = renderField();
    fireEvent.keyDown(harness.input, { key: "a" });
    expect(harness.acts).toStrictEqual([]);
  });

  it("offers next and previous as buttons too", () => {
    const harness = renderField();
    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous match" }));
    expect(harness.acts).toStrictEqual(["step:next", "step:previous"]);
  });

  it("negative control: with no matches the step buttons are disabled", () => {
    renderField({ result: findInTranscript([], "nothing here"), query: "nothing here" });
    for (const name of ["Next match", "Previous match"]) {
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
    }
  });
});

describe("find field — the chord puts the caret in the field", () => {
  it("takes focus and selects the query when the field is asked for", () => {
    // The chord's whole point is that the next keystroke enters the query. Before
    // this the field mounted with focus still on the ledger or the palette.
    const harness = renderField({ query: "hit" });
    expect(document.activeElement).toBe(harness.input);
    expect(harness.input.selectionStart).toBe(0);
    expect(harness.input.selectionEnd).toBe("hit".length);
  });

  it("takes the caret back when the chord is pressed over an open field", () => {
    // A mount-only effect covers the first open and not this one, which is why the
    // press count is a prop rather than `autoFocus`.
    const { rerender } = render(
      <FindBox
        query="hit"
        result={matchingResult()}
        currentMatchIndex={-1}
        openRequestCount={1}
        onQueryChange={() => undefined}
        onStep={() => undefined}
        onClose={() => undefined}
      />,
    );
    const input = screen.getByRole("searchbox", {
      name: "Find in this session",
    }) as HTMLInputElement;
    input.blur();
    expect(document.activeElement).not.toBe(input);
    rerender(
      <FindBox
        query="hit"
        result={matchingResult()}
        currentMatchIndex={-1}
        openRequestCount={2}
        onQueryChange={() => undefined}
        onStep={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(document.activeElement).toBe(input);
    expect(input.selectionEnd).toBe("hit".length);
  });

  it("negative control: a re-render that did not open the field leaves focus alone", () => {
    // Without this the two cases above would pass over an effect with no dependency
    // list, which would snatch focus back on every keystroke and every result
    // recompute.
    const { rerender } = render(
      <FindBox
        query="hit"
        result={matchingResult()}
        currentMatchIndex={-1}
        openRequestCount={1}
        onQueryChange={() => undefined}
        onStep={() => undefined}
        onClose={() => undefined}
      />,
    );
    const input = screen.getByRole("searchbox", {
      name: "Find in this session",
    }) as HTMLInputElement;
    input.blur();
    rerender(
      <FindBox
        query="hit"
        result={matchingResult()}
        currentMatchIndex={2}
        openRequestCount={1}
        onQueryChange={() => undefined}
        onStep={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(document.activeElement).not.toBe(input);
  });

  it("closes on Escape, so the caret it took has a keyboard way out", () => {
    const harness = renderField();
    fireEvent.keyDown(harness.input, { key: "Escape" });
    expect(harness.acts).toStrictEqual(["close"]);
  });

  it("negative control: an ordinary keystroke does not close the field", () => {
    const harness = renderField();
    fireEvent.keyDown(harness.input, { key: "a" });
    expect(harness.acts).toStrictEqual([]);
  });
});

describe("find field — the query and the close", () => {
  it("hands each keystroke to its caller rather than holding a query of its own", () => {
    const harness = renderField({ query: "hi" });
    fireEvent.change(harness.input, { target: { value: "hit" } });
    expect(harness.acts).toStrictEqual(["query:hit"]);
  });

  it("renders the query it was given, and not the one the matcher trimmed", () => {
    // The field shows what somebody typed; `result.query` is the trimmed form the
    // matcher actually ran. Conflating them would delete a trailing space out
    // from under the cursor.
    const harness = renderField({ query: "hit " });
    expect(harness.input.value).toBe("hit ");
  });

  it("closes through its caller", () => {
    const harness = renderField();
    fireEvent.click(screen.getByRole("button", { name: "Close find" }));
    expect(harness.acts).toStrictEqual(["close"]);
  });
});
