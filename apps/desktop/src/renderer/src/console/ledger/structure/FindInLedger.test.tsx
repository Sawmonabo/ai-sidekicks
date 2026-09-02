// The find field, and the sentence that is the feature.
//
// The boundary note and the "load earlier" affordance are asserted here against
// the model's own constant rather than against a literal typed twice, because two
// copies would let the field drop the caption while this file kept passing against
// its own string. The counter gets the same treatment from the other side: the
// honest total and the capped walk are different numbers, and the field must show
// the honest one.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FindInLedger } from "./FindInLedger.js";
import {
  LEDGER_FIND_SCOPE_NOTE,
  emptyFindResult,
  findInLedger,
  type LedgerFindResult,
} from "./find-model.js";
import { runRow } from "./row-fixtures.js";

/** Three rows, all matching "hit", so a query produces a walkable list. */
function matchingResult(hasEarlierRows = false): LedgerFindResult {
  return findInLedger(
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
    hasEarlierRows,
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
    readonly result?: LedgerFindResult;
    readonly query?: string;
    readonly currentMatchIndex?: number;
    /** Whether a caller can page earlier rows at all. Absent, no affordance is drawn. */
    readonly canLoadEarlier?: boolean;
  } = {},
): FindHarness {
  const acts: string[] = [];
  const result = options.result ?? matchingResult();
  const loadEarlier = (): void => {
    acts.push("load-earlier");
  };
  render(
    <FindInLedger
      query={options.query ?? result.query}
      result={result}
      currentMatchIndex={options.currentMatchIndex ?? -1}
      onQueryChange={(query) => acts.push(`query:${query}`)}
      onStep={(direction) => acts.push(`step:${direction}`)}
      {...(options.canLoadEarlier === false ? {} : { onLoadEarlier: loadEarlier })}
      onClose={() => acts.push("close")}
    />,
  );
  return {
    field: screen.getByRole("search"),
    acts,
    input: screen.getByRole("searchbox", { name: "Find in ledger" }),
  };
}

describe("find field — the boundary is rendered, never remembered", () => {
  it("states the scope in the model's own sentence", () => {
    const { field } = renderField();
    expect(field.textContent).toContain(LEDGER_FIND_SCOPE_NOTE);
  });

  it("offers to load earlier rows exactly when there are earlier rows", () => {
    const harness = renderField({ result: matchingResult(true) });
    fireEvent.click(screen.getByRole("button", { name: "Load earlier" }));
    expect(harness.acts).toStrictEqual(["load-earlier"]);
  });

  it("negative control: over a complete window the affordance is absent", () => {
    // Offering it would promise a press that could deliver nothing, and would
    // make the scope sentence read as a warning about a boundary that is not
    // there.
    renderField({ result: matchingResult(false) });
    expect(screen.queryByRole("button", { name: "Load earlier" })).toBeNull();
  });

  it("draws no affordance where the reader cannot page, and still states the boundary", () => {
    // The window IS partial and no registered read fetches what is missing. The
    // sentence is the honest half and survives; the button is the half that would
    // be a promise, and it is absent rather than drawn dead.
    const { field } = renderField({ result: matchingResult(true), canLoadEarlier: false });
    expect(screen.queryByRole("button", { name: "Load earlier" })).toBeNull();
    expect(field.textContent).toContain(LEDGER_FIND_SCOPE_NOTE);
  });
});

describe("find field — the counter is the console's own reading", () => {
  it("reports how much was searched before anything is typed", () => {
    const { field } = renderField({ result: emptyFindResult(42, false), query: "" });
    expect(field.textContent).toContain("42 rows loaded");
  });

  it("names a position within the honest total", () => {
    const { field } = renderField({ currentMatchIndex: 1 });
    expect(field.textContent).toContain("2 of 3");
  });

  it("shows the true total even when the walk is capped", () => {
    // A counter that silently equalled the cap would tell a person their query is
    // narrower than it is.
    const capped: LedgerFindResult = { ...matchingResult(), totalMatchCount: 940 };
    const { field } = renderField({ result: capped, currentMatchIndex: 0 });
    expect(field.textContent).toContain("1 of 940");
    expect(field.textContent).not.toContain("1 of 3");
  });

  it("negative control: with nothing found it says so, and says it once", () => {
    const empty = findInLedger([], "nothing here", false);
    const { field } = renderField({ result: empty, query: "nothing here" });
    expect(field.textContent).toContain("No matches");
    expect(field.textContent).toContain("No loaded row matches that.");
  });

  it("negative control: an untouched field shows no empty state", () => {
    // The empty state is a fact about a QUERY. Showing it before one is typed
    // would report a failed search nobody ran.
    const { field } = renderField({ result: emptyFindResult(3, false), query: "" });
    expect(field.textContent).not.toContain("No loaded row matches that.");
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
    renderField({ result: findInLedger([], "nothing here", false), query: "nothing here" });
    for (const name of ["Next match", "Previous match"]) {
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
    }
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
