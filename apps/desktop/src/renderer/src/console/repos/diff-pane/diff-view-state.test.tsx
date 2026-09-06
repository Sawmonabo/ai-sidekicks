// One diff's view state, driven through the hook's own door.
//
// WHY THE HOOK AND NOT THE PANE. `DiffPane.test.tsx` already holds what a person
// sees — a selection the new change set does not contain drops instead of narrowing
// the rows to nothing, and the gap expansion does not carry over by index. Those
// cases go through the DOM, and the DOM cannot reach the half of this rule that is
// about a HANDLER: React dispatches an event with the props of the render that is on
// screen, so a click can never carry a callback captured under the previous model.
// Every consumer of this hook can, because both of them pass the callbacks down as
// props and either could hold one across the move — which is the write the console's
// subject rule drops and the register this module used to keep did not.
//
// THE CAPTURED HANDLER IS PAIRED WITH ITS CONTROL. A `selectFilePath` that did
// nothing at all would satisfy "writes nowhere once the model has moved" without
// being the rule; the control drives the identical capture while the model stands and
// requires it to write.

import { act, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { buildDiffFixture } from "./diff-fixture.test-support.js";
import { SMALL_DIFF_SHAPE } from "./diff-fixture-shapes.test-support.js";
import type { ConsoleDiffModel } from "./diff-model.js";
import { diffGapKey, type DiffGapExpansion } from "./diff-row-model.js";
import { useDiffModelViewState, type DiffModelViewState } from "./diff-view-state.js";

/** What the probe renders where the whole change set is shown. */
const WHOLE_CHANGE_SET = "(whole change set)";

/** What the probe renders where no gap has been unfolded. */
const NOTHING_UNFOLDED = "(nothing unfolded)";

/** The first file's first gap, which every case below unfolds. */
const FIRST_GAP = { fileIndex: 0, hunkIndex: 0 } as const;

/**
 * One press reveals a whole four-line gap on this shape.
 *
 * Read off the shape rather than written as `4`, so a fixture whose hidden context
 * grows past one expansion band fails here instead of silently asserting a partial
 * reveal the case was not about.
 */
const WHOLE_FIRST_GAP = SMALL_DIFF_SHAPE.precedingContextPerHunk;

/** A change set whose files share no path with the fixture's. */
function otherDiff(): ConsoleDiffModel {
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
  readonly diff: ConsoleDiffModel | undefined;
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
 * Drive the hook and keep every render's state, newest last.
 *
 * The whole list rather than the latest, because the cases about a captured handler
 * need the state one particular render produced and the ones about what is on screen
 * need the last.
 */
class ViewStateProbeDriver {
  readonly #states: DiffModelViewState[] = [];
  readonly #view: ReturnType<typeof render>;

  public constructor(diff: ConsoleDiffModel | undefined) {
    this.#view = render(<ViewStateProbe diff={diff} onRender={this.#record} />);
  }

  readonly #record = (state: DiffModelViewState): void => {
    this.#states.push(state);
  };

  public showDiff(diff: ConsoleDiffModel | undefined): void {
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
    // Without this the case above would pass over a hook that dropped its state on
    // every render, which would take a person's selection away the instant anything
    // else in the console moved.
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
    // A -> B -> A. The return is a SECOND visit to the same model and not a resumption
    // of the first: the state that belonged to it was dropped when B arrived, and a
    // hook that handed it back would be holding a value across a subject it was never
    // about.
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
    // The half of the rule the DOM cannot reach, and the one this module used to
    // leave open: the setter it handed out was the mount's and named no model, so a
    // consumer holding it across the move selected a path the new change set does not
    // contain — the index narrows to no file, `rowCount` is zero, and the renderer
    // states that two states are identical over a change set that has changes.
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
    // Without this the case above would pass over handlers that wrote nowhere at all,
    // which is not the rule — it is a hook that does not work.
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
