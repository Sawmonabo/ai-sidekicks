// The mount, props builder and row-count reader for the renderer suite, `DiffRenderer.test.ts`.
// The props builder names every prop, so a stale copy would keep compiling against a component
// nobody renders that way.

import { render } from "@testing-library/react";

import { buildDiffFixture } from "@test/helpers/diff-fixture.js";
import { liveBridgeWrapper } from "@test/helpers/app-frame-fixtures.js";
import { SMALL_DIFF_SHAPE } from "@test/helpers/diff-fixture-shapes.js";
import { DiffRenderer } from "./DiffRenderer.js";
import type { DiffGapExpansion } from "../diff-row-model.js";

/** The change set every case renders unless it names another. */
export const SMALL_DIFF: ReturnType<typeof buildDiffFixture> = buildDiffFixture(SMALL_DIFF_SHAPE);

/**
 * No gap expanded, the start of every case. A function, not a shared `Map`: the expansion type
 * hides its mutators only at compile time, so one case expanding a gap would leak into the rest.
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
  return render(<DiffRenderer {...diffRendererProps(overrides)} />, {
    wrapper: liveBridgeWrapper(),
  }).container;
}
