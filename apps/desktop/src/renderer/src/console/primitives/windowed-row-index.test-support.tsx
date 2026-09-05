// The list the roving-index cases drive, and the two scans they read it with.
//
// Not a test file — no `include` glob reaches it; the three co-located suites import
// it, the way `live-region.test-support.ts` is imported. It exists because those
// suites all need the same windowed list and the same "what would Tab reach" scan,
// and `apps/desktop` AGENTS.md hoists a helper on its second use. A second copy of
// the fixture is the failure mode that matters here: two lists differing in which
// element carries the stop would let one suite pass on a shape the other rejects.
//
// THE FIXTURE HANDS THE HOOK THE SHAPE A VIRTUALIZER HANDS BACK: the mounted row
// array itself, rebuilt every render. A stable derivation of it — a joined string —
// makes the expiry cases pass against an implementation that compares the option's
// identity, which is a property of the fixture and not of the hook. The array is the
// harder value and the real one.

import { act } from "@testing-library/react";
import { useRef } from "react";

import { WindowedListRow } from "./WindowedListRow.js";
import { useWindowedRovingIndex } from "./windowed-row-index.js";
import { WINDOWED_ROW_INDEX_ATTRIBUTE } from "./windowed-row-markers.js";

/** A windowed list reduced to what the hook touches: a slice, an anchor, a reveal. */
export function RovingList(props: {
  readonly rowCount: number;
  readonly windowStart: number;
  readonly windowLength: number;
  /** Where the keyboard starts. Zero unless a case is about the anchor itself. */
  readonly anchorIndex?: number;
  readonly onReveal: (rowIndex: number) => void;
}): React.JSX.Element {
  const containerRef = useRef<HTMLUListElement | null>(null);
  const mountedIndexes = Array.from(
    { length: Math.min(props.windowLength, Math.max(props.rowCount - props.windowStart, 0)) },
    (unused, offset) => props.windowStart + offset,
  );
  const { activeIndex, onKeyDown } = useWindowedRovingIndex({
    rowCount: props.rowCount,
    anchorIndex: props.anchorIndex ?? 0,
    containerRef,
    revealIndex: props.onReveal,
    windowRevision: mountedIndexes,
  });
  return (
    <ul ref={containerRef} onKeyDown={onKeyDown} data-active-index={activeIndex}>
      {mountedIndexes.map((rowIndex) => (
        <WindowedListRow
          key={rowIndex}
          as="li"
          rowIndex={rowIndex}
          totalRowCount={props.rowCount}
          isTabbable={rowIndex === activeIndex}
        >
          {(targetProps) => (
            <button type="button" {...targetProps}>{`row ${String(rowIndex)}`}</button>
          )}
        </WindowedListRow>
      ))}
    </ul>
  );
}

/**
 * The index of every row Tab would reach, read from the element that holds the stop.
 *
 * The stop is on the row's declared target rather than on the `<li>`, so the index is
 * read by climbing from it — which is also the assertion: a stop that was not inside
 * a row would produce an empty string here rather than quietly not being counted.
 */
export function tabbableIndexes(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll<HTMLElement>('[tabindex="0"]')].map(
    (target) =>
      target.closest<HTMLElement>(`[${WINDOWED_ROW_INDEX_ATTRIBUTE}]`)?.dataset["index"] ?? "",
  );
}

/** Every element in the list that Tab would reach — the platform's rule, not a proxy. */
export function sequentialTabStops(container: HTMLElement): readonly HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>("*")].filter((element) => {
    const declared = element.getAttribute("tabindex");
    return declared === null
      ? element.matches("button, a[href], input, select, textarea")
      : Number(declared) >= 0;
  });
}

/** The list element, or a failure that names what did not render. */
export function listOf(container: HTMLElement): HTMLElement {
  const list = container.querySelector("ul");
  if (list === null) {
    throw new Error("the list did not render");
  }
  return list;
}

/** Press `End`, and let every effect the press schedules run. */
export async function pressEnd(list: HTMLElement): Promise<void> {
  await act(async () => {
    list.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
  });
}

/**
 * The list with something else on the page to tab to.
 *
 * The steal this block is about is only observable against a second focus target:
 * "focus did not move" is a claim about where it stayed, and the body is where focus
 * goes when nothing holds it, which is also where a dropped claim leaves it.
 */
export function ListWithNeighbour(props: {
  readonly rowCount: number;
  readonly windowStart: number;
  readonly windowLength: number;
}): React.JSX.Element {
  return (
    <>
      <RovingList
        rowCount={props.rowCount}
        windowStart={props.windowStart}
        windowLength={props.windowLength}
        onReveal={() => undefined}
      />
      <button type="button" data-neighbour="">
        elsewhere
      </button>
    </>
  );
}

/** The element the reader tabbed to, read back from the tree that rendered it. */
export function neighbourOf(container: HTMLElement): HTMLElement {
  const neighbour = container.querySelector<HTMLElement>("[data-neighbour]");
  if (neighbour === null) {
    throw new Error("the neighbour did not render");
  }
  return neighbour;
}
