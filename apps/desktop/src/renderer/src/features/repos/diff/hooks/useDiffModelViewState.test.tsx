// One diff's view state, driven through the hook itself. `DiffPane.test.tsx` covers what a
// person sees; the DOM cannot reach a handler captured under the previous model, because
// React dispatches with the props of the render on screen. The captured handler is paired
// with its control: a setter that did nothing would satisfy "writes nowhere after the move".

import { act, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { buildDiffFixture } from "@test/helpers/diff-fixture.js";
import { SMALL_DIFF_SHAPE } from "@test/helpers/diff-fixture-shapes.js";
import type { DiffModel } from "../diff-model.js";
import { diffGapKey, type DiffGapExpansion } from "../diff-row-model.js";
import { useDiffModelViewState, type DiffModelViewState } from "./useDiffModelViewState.js";

/** What the probe renders where the whole change set is shown. */
const WHOLE_CHANGE_SET = "(whole change set)";

/** What the probe renders where no gap has been unfolded. */
const NOTHING_UNFOLDED = "(nothing unfolded)";

/** The first file's first gap, which every case below unfolds. */
const FIRST_GAP = { fileIndex: 0, hunkIndex: 0 } as const;

/**
 * One press reveals a whole four-line gap on this shape. Read off the shape so a fixture
 * whose hidden context outgrows one expansion band fails here instead of asserting a partial
 * reveal.
 */
const WHOLE_FIRST_GAP = SMALL_DIFF_SHAPE.precedingContextPerHunk;

/** A change set whose files share no path with the fixture's. */
function otherDiff(): DiffModel {
  const whole = buildDiffFixture(SMALL_DIFF_SHAPE);
  return { ...whole, files: whole.files.map((file) => ({ ...file, path: `other/${file.path}` })) };
}

/** The expansion as one comparable string, sorted so entry order cannot decide a case. */
function renderExpansion(expansion: DiffGapExpansion): string {
  const entries = [...expansion.entries()]
    .map(([key, revealed]) => `${key}=${String(revealed)}`)
    .sort();
  return entries.length === 0 ? NOTHING_UNFOLDED : entries.join(" ");
}

interface ViewStateProbeProps {
  readonly diff: DiffModel | undefined;
  /** Handed this render's state, so a case may hold one and use it after the move. */
  readonly onRender: (state: DiffModelViewState) => void;
}

function ViewStateProbe(props: ViewStateProbeProps): ReactElement {
  const state = useDiffModelViewState(props.diff);
  props.onRender(state);
  return (
    <>
      <output data-testid="selection">{state.selectedFilePath ?? WHOLE_CHANGE_SET}</output>
      <output data-testid="expansion">{renderExpansion(state.expansion)}</output>
    </>
  );
}

/**
 * Drive the hook and keep every render's state, newest last. The whole list, because
 * captured-handler cases need one particular render's state and the others need the last.
 */
class ViewStateProbeDriver {
  readonly #states: DiffModelViewState[] = [];
  readonly #view: ReturnType<typeof render>;

  readonly #record = (state: DiffModelViewState): void => {
    this.#states.push(state);
  };

  public constructor(diff: DiffModel | undefined) {
    this.#view = render(<ViewStateProbe diff={diff} onRender={this.#record} />);
  }

  public showDiff(diff: DiffModel | undefined): void {
    this.#view.rerender(<ViewStateProbe diff={diff} onRender={this.#record} />);
  }

  /** The state of the render that is on screen. */
  public get shown(): DiffModelViewState {
    const latest = this.#states.at(-1);
    if (latest === undefined) {
      throw new Error("The diff view-state probe was read before it rendered");
    }
    return latest;
  }

  /** The state the render on screen right now produced, held for use after a move. */
  public captureHandlers(): DiffModelViewState {
    return this.shown;
  }

  public get selection(): string {
    return this.#view.getByTestId("selection").textContent ?? "";
  }

  public get expansion(): string {
    return this.#view.getByTestId("expansion").textContent ?? "";
  }
}

describe("diff view state — what one diff holds, and what a move drops", () => {
  it("narrows the rows to one file and unfolds one gap", () => {
    const diff = buildDiffFixture(SMALL_DIFF_SHAPE);
    const driver = new ViewStateProbeDriver(diff);
    const shownPath = diff.files[1]?.path;
    expect(shownPath).toBeDefined();

    act(() => {
      driver.shown.selectFilePath(shownPath);
      driver.shown.expandGapAt(FIRST_GAP.fileIndex, FIRST_GAP.hunkIndex);
    });

    expect(driver.selection).toBe(shownPath);
    expect(driver.expansion).toBe(
      `${diffGapKey(FIRST_GAP.fileIndex, FIRST_GAP.hunkIndex)}=${String(WHOLE_FIRST_GAP)}`,
    );
  });

  it("drops both when the model moves", () => {
    const driver = new ViewStateProbeDriver(buildDiffFixture(SMALL_DIFF_SHAPE));
    act(() => {
      driver.shown.selectFilePath("module-01.ts");
      driver.shown.expandGapAt(FIRST_GAP.fileIndex, FIRST_GAP.hunkIndex);
    });

    act(() => {
      driver.showDiff(otherDiff());
    });

    expect(driver.selection).toBe(WHOLE_CHANGE_SET);
    expect(driver.expansion).toBe(NOTHING_UNFOLDED);
  });

  it("negative control: the same model object across renders keeps both", () => {
    // Without this the case above would pass over a hook that dropped its state every render.
    const sameDiff = buildDiffFixture(SMALL_DIFF_SHAPE);
    const driver = new ViewStateProbeDriver(sameDiff);
    act(() => {
      driver.shown.selectFilePath("module-01.ts");
      driver.shown.expandGapAt(FIRST_GAP.fileIndex, FIRST_GAP.hunkIndex);
    });
    const unfolded = driver.expansion;

    act(() => {
      driver.showDiff(sameDiff);
    });

    expect(driver.selection).toBe("module-01.ts");
    expect(driver.expansion).toBe(unfolded);
  });

  it("re-seeds on a return to the model it left, rather than restoring what it dropped", () => {
    // A -> B -> A is a second visit to the model, not a resumption: its state was dropped when
    // B arrived, and handing it back would hold a value across a subject it was never about.
    const first = buildDiffFixture(SMALL_DIFF_SHAPE);
    const driver = new ViewStateProbeDriver(first);
    act(() => {
      driver.shown.selectFilePath("module-01.ts");
      driver.shown.expandGapAt(FIRST_GAP.fileIndex, FIRST_GAP.hunkIndex);
    });

    act(() => {
      driver.showDiff(otherDiff());
    });
    act(() => {
      driver.showDiff(first);
    });

    expect(driver.selection).toBe(WHOLE_CHANGE_SET);
    expect(driver.expansion).toBe(NOTHING_UNFOLDED);
  });
});

describe("diff view state — a handler captured under the previous diff", () => {
  it("narrows nowhere once the model has moved", () => {
    // The half of the rule the DOM cannot reach: a consumer holding the setter across the move
    // must not select a path the new change set lacks, which would narrow to no rows and
    // render "nothing to review" over a change set that has changes.
    const first = buildDiffFixture(SMALL_DIFF_SHAPE);
    const heldPath = first.files[1]?.path;
    expect(heldPath).toBeDefined();
    const driver = new ViewStateProbeDriver(first);
    const capturedUnderFirst = driver.captureHandlers();

    act(() => {
      driver.showDiff(otherDiff());
    });
    act(() => {
      capturedUnderFirst.selectFilePath(heldPath);
      capturedUnderFirst.expandGapAt(FIRST_GAP.fileIndex, FIRST_GAP.hunkIndex);
    });

    expect(driver.selection).toBe(WHOLE_CHANGE_SET);
    expect(driver.expansion).toBe(NOTHING_UNFOLDED);
  });

  it("negative control: the same captured handler still writes while the model stands", () => {
    // Without this the case above would pass over handlers that wrote nowhere at all.
    const first = buildDiffFixture(SMALL_DIFF_SHAPE);
    const heldPath = first.files[1]?.path;
    expect(heldPath).toBeDefined();
    const driver = new ViewStateProbeDriver(first);
    const capturedUnderFirst = driver.captureHandlers();

    act(() => {
      driver.showDiff(first);
    });
    act(() => {
      capturedUnderFirst.selectFilePath(heldPath);
      capturedUnderFirst.expandGapAt(FIRST_GAP.fileIndex, FIRST_GAP.hunkIndex);
    });

    expect(driver.selection).toBe(heldPath);
    expect(driver.expansion).toBe(
      `${diffGapKey(FIRST_GAP.fileIndex, FIRST_GAP.hunkIndex)}=${String(WHOLE_FIRST_GAP)}`,
    );
  });
});
