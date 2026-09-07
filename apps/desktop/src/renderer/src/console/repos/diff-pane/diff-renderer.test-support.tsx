// How both renderer suites mount the diff and read the count it reports.
//
// SPLIT BY SUBJECT, NOT BY SCAFFOLDING. `DiffRenderer.test.tsx` is about the ROWS the
// renderer draws and `DiffRenderer.geometry.test.tsx` about the offsets under them,
// and the props builder, the mount and the row-count reader were copied into both
// rather than hoisted. The props builder is the one that matters: it names every prop
// the component takes, so the copy that was not updated the day one moved would have
// gone on compiling against a component nobody renders that way.

import { render } from "@testing-library/react";

import { buildDiffFixture } from "./diff-fixture.test-support.js";
import { SMALL_DIFF_SHAPE } from "./diff-fixture-shapes.test-support.js";
import { DiffRenderer } from "./DiffRenderer.js";
import type { DiffGapExpansion } from "./diff-row-model.js";

/** The change set both suites render unless a case names another. */
export const SMALL_DIFF: ReturnType<typeof buildDiffFixture> = buildDiffFixture(SMALL_DIFF_SHAPE);

/**
 * No gap expanded, which is what every case starts from.
 *
 * A FUNCTION AND NOT A SHARED EMPTY MAP. An exported `Map` is one object every case in
 * both suites would hold, and `DiffGapExpansion` hides its mutators from a reader and
 * from nothing at runtime — so a single case that expanded a gap through the prop it
 * was handed would carry that expansion into every case after it, in whatever order
 * the runner happened to pick. Each caller gets its own.
 */
export function noExpansion(): DiffGapExpansion {
  return new Map();
}

/** The row count the scroller reports for the whole diff. */
export function reportedRowCount(container: HTMLElement): number {
  return Number(container.querySelector(".meridian-diff")?.getAttribute("aria-rowcount"));
}

/** The renderer's props for a case, with whatever that case cares about replaced. */
export function diffRendererProps(
  overrides: Partial<React.ComponentProps<typeof DiffRenderer>> = {},
): React.ComponentProps<typeof DiffRenderer> {
  return {
    model: SMALL_DIFF,
    viewMode: "unified",
    showAttributionMarks: true,
    wrapLongLines: false,
    showWhitespaceChanges: true,
    expansion: noExpansion(),
    onExpandGap: () => undefined,
    label: "Diff, main to feat/rate-limit-wiring",
    ...overrides,
  };
}

/** Mount the renderer over those props. */
export function renderDiff(
  overrides: Partial<React.ComponentProps<typeof DiffRenderer>> = {},
): HTMLElement {
  return render(<DiffRenderer {...diffRendererProps(overrides)} />).container;
}
