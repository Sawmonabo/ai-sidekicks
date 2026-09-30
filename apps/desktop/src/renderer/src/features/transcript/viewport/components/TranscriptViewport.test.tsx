// What the viewport draws and refuses to mount. `happy-dom` answers zero for every geometry
// read, so geometry-dependent states (the tail pill, the anchor holding across an append) are
// asserted in `reading-anchor.test.ts` and `viewport-controller.test.ts`. Here: the feed is
// named, only a slice of the log is in the document, and a settled viewport has no timer
// armed. `withLaidOutViewport` stands in for the layout engine
// only; every module in the assertion path is the shipped one.

import { act, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ManualClock, type Clock } from "@renderer/lib/clock.js";
import { TranscriptViewport } from "./TranscriptViewport.js";
import {
  useTranscriptViewport,
  type TranscriptViewportBinding,
} from "../hooks/useTranscriptViewport.js";
import type { ViewportRow } from "../viewport-snapshot.js";

const LONG_LOG_ROW_COUNT = 500;
const LAID_OUT_VIEWPORT_HEIGHT_PX = 400;
const LAID_OUT_CONTENT_HEIGHT_PX = 10_000;

/**
 * Give every element a viewport height for one case: `happy-dom` reports zero, and the
 * virtualizer treats a zero outer size as no range at all.
 */
function withLaidOutViewport(): void {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(
    LAID_OUT_VIEWPORT_HEIGHT_PX,
  );
}

/**
 * Give the box content taller than itself for one case. Separate from the layout stub because
 * the chokepoint clamps writes to `scrollHeight - clientHeight`; only the scroll cases pay for it.
 */
function withScrollableContent(): void {
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
    LAID_OUT_CONTENT_HEIGHT_PX,
  );
}

interface BindingHolder {
  binding: TranscriptViewportBinding | undefined;
}

interface BoundTranscriptViewportProps {
  readonly clock: Clock;
  readonly rows: readonly ViewportRow[];
  readonly renderRow: (row: ViewportRow) => React.ReactNode;
  readonly feedLabel: string;
  /** Filled on every commit, so a case can act on the binding the viewport got. */
  readonly holder?: BindingHolder;
}

/**
 * The composition every viewport caller performs: mint one binding, hand it down. The viewport
 * does not mint its own, so rendering it bare would assert against an unrenderable component.
 */
function BoundTranscriptViewport(props: BoundTranscriptViewportProps): React.JSX.Element {
  const binding = useTranscriptViewport({
    clock: props.clock,
    rows: props.rows,
    hasActiveTurn: false,
    isRevealDraining: false,
  });
  const { holder } = props;
  useEffect(() => {
    if (holder !== undefined) {
      holder.binding = binding;
    }
  });
  return (
    <TranscriptViewport
      binding={binding}
      renderRow={props.renderRow}
      feedLabel={props.feedLabel}
      firstReadSettled
    />
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

function syntheticRows(count: number): readonly ViewportRow[] {
  return Array.from({ length: count }, (_unused, index) => ({
    key: `row-${String(index)}`,
    parentKey: undefined,
    rootCursor: `cursor-${String(index)}`,
  }));
}

function renderRow(row: ViewportRow): React.ReactNode {
  return <p>{row.key}</p>;
}

describe("the transcript viewport — the feed", () => {
  it("names the feed, and mounts far fewer rows than the log holds", () => {
    withLaidOutViewport();
    const { container } = render(
      <BoundTranscriptViewport
        clock={new ManualClock()}
        rows={syntheticRows(LONG_LOG_ROW_COUNT)}
        renderRow={renderRow}
        feedLabel="Transcript"
      />,
    );
    expect(screen.getByRole("feed", { name: "Transcript" })).toBeDefined();
    const mounted = container.querySelectorAll(".meridian-transcript-viewport__row");
    expect(mounted.length).toBeGreaterThan(0);
    expect(mounted.length).toBeLessThan(LONG_LOG_ROW_COUNT / 4);
  });

  it("arms no timer once the first paint has settled", () => {
    withLaidOutViewport();
    const clock = new ManualClock();
    render(
      <BoundTranscriptViewport
        clock={clock}
        rows={syntheticRows(20)}
        renderRow={renderRow}
        feedLabel="Transcript"
      />,
    );
    // Row measurements coalesce onto one frame; after that a quiet viewport holds nothing armed.
    for (let pass = 0; pass < 4; pass += 1) {
      clock.runFrame();
    }
    expect(clock.pendingCount).toBe(0);
  });

  it("draws both rows of a projection that repeated a key", () => {
    withLaidOutViewport();
    const rows: readonly ViewportRow[] = [
      { key: "row-0", parentKey: undefined, rootCursor: "cursor-0" },
      { key: "row-0", parentKey: undefined, rootCursor: "cursor-1" },
    ];
    const { container } = render(
      <BoundTranscriptViewport
        clock={new ManualClock()}
        rows={rows}
        renderRow={renderRow}
        feedLabel="Transcript"
      />,
    );
    // Both rows are in the document under keys of their own; a shared key would leave one,
    // because the library's caches are keyed by item key.
    expect(container.querySelectorAll(".meridian-transcript-viewport__row")).toHaveLength(2);
  });
  it("scrolls the scroll container through the binding its caller owns", () => {
    withLaidOutViewport();
    withScrollableContent();
    const holder: BindingHolder = { binding: undefined };
    const { container } = render(
      <BoundTranscriptViewport
        clock={new ManualClock()}
        rows={syntheticRows(LONG_LOG_ROW_COUNT)}
        renderRow={renderRow}
        feedLabel="Transcript"
        holder={holder}
      />,
    );
    const scrollContainer = container.querySelector<HTMLElement>(
      ".meridian-transcript-viewport__scroll-container",
    );
    expect(scrollContainer).not.toBeNull();
    expect(scrollContainer?.scrollTop).toBe(0);
    act(() => {
      holder.binding?.jumpToTail();
    });
    // The caller's binding reaches the element because the viewport takes it as a prop.
    expect(scrollContainer?.scrollTop).toBeGreaterThan(0);
  });
});
