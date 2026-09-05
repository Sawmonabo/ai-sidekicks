// The shrinking-set defect, driven — plus the two halves of a move.
//
// The defect this file exists for is the one that is invisible until it happens: a
// person arrows down a long list, a filter narrows it, and the remembered index now
// matches no mounted row, so nothing in the list is tabbable and the whole list
// leaves the page's tab order. The negative control is the unclamped expression that
// shipped: it answers an index past the end, which is exactly what makes the list
// unreachable.
//
// A `.tsx` file because the hook half needs a tree to move focus inside. The pure
// half is driven directly, without one.
//
// THE FIXTURE HANDS THE HOOK THE SHAPE A VIRTUALIZER HANDS BACK: the mounted row
// array itself, rebuilt every render. A stable derivation of it — the joined string
// this file drove before — makes the expiry cases pass against an implementation
// that compares the option's identity, which is a property of the fixture and not of
// the hook. The array is the harder value and the real one.

import { act, render } from "@testing-library/react";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { WindowedListRow } from "./WindowedListRow.js";
import {
  WINDOWED_ROW_INDEX_ATTRIBUTE,
  WINDOWED_ROW_MOVE_BY_KEY,
  clampedRowIndex,
  movedRowIndex,
  useWindowedRovingIndex,
  type WindowedRowMove,
} from "./windowed-row-index.js";

describe("windowed-row-index — where a move lands", () => {
  it("clamps at both ends rather than wrapping", () => {
    expect(movedRowIndex("next", 4, 5)).toBe(4);
    expect(movedRowIndex("previous", 0, 5)).toBe(0);
    expect(movedRowIndex("first", 3, 5)).toBe(0);
    expect(movedRowIndex("last", 0, 5)).toBe(4);
  });

  it("negative control: a wrapping implementation answers differently at each end", () => {
    // Without this the clamps above would also be satisfied by an implementation
    // that wrapped, since wrapping and clamping agree everywhere except the ends.
    expect(movedRowIndex("next", 4, 5)).not.toBe(0);
    expect(movedRowIndex("previous", 0, 5)).not.toBe(4);
  });

  it("handles every key in the table", () => {
    const moves = Object.values(WINDOWED_ROW_MOVE_BY_KEY);
    expect(new Set(moves).size).toBe(moves.length);
    for (const move of moves) {
      expect(Number.isInteger(movedRowIndex(move, 2, 5))).toBe(true);
    }
  });
});

describe("windowed-row-index — a position in the set that exists now", () => {
  it("discards a remembered index the set no longer has", () => {
    expect(clampedRowIndex(39, 5)).toBe(4);
  });

  it("negative control: the unclamped expression leaves the list unreachable", () => {
    // The shipped defect, stated as arithmetic: a remembered 39 over five rows
    // matches no row, so no row is tabbable. The clamp is what makes the two differ.
    const rememberedIndex = 39;
    const rowCount = 5;
    expect(rememberedIndex).toBeGreaterThan(rowCount - 1);
    expect(clampedRowIndex(rememberedIndex, rowCount)).toBeLessThan(rowCount);
  });

  it("answers zero for an empty set and for a value that is not a position", () => {
    expect(clampedRowIndex(3, 0)).toBe(0);
    expect(clampedRowIndex(-2, 5)).toBe(0);
    expect(clampedRowIndex(Number.NaN, 5)).toBe(0);
  });
});

/** A windowed list reduced to what the hook touches: a slice, and a reveal call. */
function RovingList(props: {
  readonly rowCount: number;
  readonly windowStart: number;
  readonly windowLength: number;
  readonly onReveal: (rowIndex: number) => void;
}): React.JSX.Element {
  const containerRef = useRef<HTMLUListElement | null>(null);
  const mountedIndexes = Array.from(
    { length: Math.min(props.windowLength, Math.max(props.rowCount - props.windowStart, 0)) },
    (unused, offset) => props.windowStart + offset,
  );
  const { activeIndex, onKeyDown } = useWindowedRovingIndex({
    rowCount: props.rowCount,
    anchorIndex: 0,
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
function tabbableIndexes(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll<HTMLElement>('[tabindex="0"]')].map(
    (target) =>
      target.closest<HTMLElement>(`[${WINDOWED_ROW_INDEX_ATTRIBUTE}]`)?.dataset["index"] ?? "",
  );
}

/** Every element in the list that Tab would reach — the platform's rule, not a proxy. */
function sequentialTabStops(container: HTMLElement): readonly HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>("*")].filter((element) => {
    const declared = element.getAttribute("tabindex");
    return declared === null
      ? element.matches("button, a[href], input, select, textarea")
      : Number(declared) >= 0;
  });
}

describe("useWindowedRovingIndex — one tab stop that survives a shrinking set", () => {
  it("keeps exactly one row tabbable after the set narrows under a remembered move", async () => {
    const { container, rerender } = render(
      <RovingList rowCount={40} windowStart={0} windowLength={40} onReveal={() => undefined} />,
    );
    const list = container.querySelector("ul");
    if (list === null) {
      throw new Error("the list did not render");
    }
    await act(async () => {
      list.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    });
    expect(tabbableIndexes(list)).toStrictEqual(["39"]);

    rerender(
      <RovingList rowCount={5} windowStart={0} windowLength={5} onReveal={() => undefined} />,
    );
    // The list is still reachable, and the stop is a position the narrowed set has.
    expect(tabbableIndexes(list)).toStrictEqual(["4"]);
  });

  it("asks the window to mount the row it moved to", async () => {
    const onReveal = vi.fn();
    const { container } = render(
      <RovingList rowCount={40} windowStart={0} windowLength={4} onReveal={onReveal} />,
    );
    const list = container.querySelector("ul");
    if (list === null) {
      throw new Error("the list did not render");
    }
    await act(async () => {
      list.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    });
    expect(onReveal).toHaveBeenCalledWith(39);
  });

  it("focuses the moved-to row once the window mounts it, and not before", async () => {
    function Harness(): React.JSX.Element {
      const [windowStart, setWindowStart] = useState(0);
      return (
        <RovingList
          rowCount={40}
          windowStart={windowStart}
          windowLength={4}
          onReveal={(rowIndex) => {
            // The window answers a beat later, exactly as a virtualizer's does.
            queueMicrotask(() => {
              setWindowStart(Math.max(rowIndex - 3, 0));
            });
          }}
        />
      );
    }
    const { container } = render(<Harness />);
    const list = container.querySelector("ul");
    if (list === null) {
      throw new Error("the list did not render");
    }
    await act(async () => {
      list.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    });
    // Row 39 was not mounted when the key landed; focus waited for the window. The
    // tag is asserted beside the text because the `<li>` and the button it wraps read
    // the same textContent — which is how focus landing on the wrapper passed here.
    expect(document.activeElement?.textContent).toBe("row 39");
    expect(document.activeElement?.tagName).toBe("BUTTON");
  });

  it("negative control: a key the table does not name is left to the page", async () => {
    const onReveal = vi.fn();
    const { container } = render(
      <RovingList rowCount={40} windowStart={0} windowLength={4} onReveal={onReveal} />,
    );
    const list = container.querySelector("ul");
    if (list === null) {
      throw new Error("the list did not render");
    }
    await act(async () => {
      list.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown", bubbles: true }));
    });
    expect(onReveal).not.toHaveBeenCalled();
  });

  it("moves nothing in an empty list", async () => {
    const onReveal = vi.fn();
    const { container } = render(
      <RovingList rowCount={0} windowStart={0} windowLength={4} onReveal={onReveal} />,
    );
    const list = container.querySelector("ul");
    if (list === null) {
      throw new Error("the list did not render");
    }
    const moves: readonly WindowedRowMove[] = Object.values(WINDOWED_ROW_MOVE_BY_KEY);
    expect(moves.length).toBeGreaterThan(0);
    await act(async () => {
      list.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(onReveal).not.toHaveBeenCalled();
  });
});

describe("useWindowedRovingIndex — a pending move is spent once, never left standing", () => {
  /** Press `End`, on a window that has not mounted the last row. */
  async function pressEnd(list: HTMLElement): Promise<void> {
    await act(async () => {
      list.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    });
  }

  function listOf(container: HTMLElement): HTMLElement {
    const list = container.querySelector("ul");
    if (list === null) {
      throw new Error("the list did not render");
    }
    return list;
  }

  it("does not steal focus on a later window change once the move has expired", async () => {
    // The defect in terms: the reader presses End, the window never mounts row 39,
    // they tab away and start typing — and an unrelated store update re-runs the
    // effect with the row mounted, pulling focus out of what they were typing in.
    const { container, rerender } = render(
      <RovingList rowCount={40} windowStart={0} windowLength={4} onReveal={() => undefined} />,
    );
    const list = listOf(container);
    await pressEnd(list);

    // One more render that does not bring row 39 in. That is the move's one retry,
    // and it is spent here.
    rerender(
      <RovingList rowCount={40} windowStart={4} windowLength={4} onReveal={() => undefined} />,
    );
    // A later window change that DOES mount it must move nothing.
    rerender(
      <RovingList rowCount={40} windowStart={36} windowLength={4} onReveal={() => undefined} />,
    );
    expect(document.activeElement?.textContent).not.toBe("row 39");
    expect(document.activeElement).toBe(document.body);
  });

  it("negative control: the one retry a reveal needs still lands the focus", async () => {
    // Without this the expiry above would also be satisfied by dropping the move on
    // the first miss, which is every asynchronous virtualizer: the row is mounted a
    // render later and the key press would move nothing at all. That is exactly what
    // an expiry keyed on the option's identity does here, because `mountedIndexes` is
    // a new array on the very render the move's own state update causes.
    const { container, rerender } = render(
      <RovingList rowCount={40} windowStart={0} windowLength={4} onReveal={() => undefined} />,
    );
    const list = listOf(container);
    await pressEnd(list);
    rerender(
      <RovingList rowCount={40} windowStart={36} windowLength={4} onReveal={() => undefined} />,
    );
    expect(document.activeElement?.textContent).toBe("row 39");
  });

  it("focuses no other row when the set narrows under a pending move", async () => {
    // The second arm of the same defect: the effect keyed on the CLAMPED index, so
    // a list that shrank between the key press and the mount answered a press about
    // row 39 by focusing row 4.
    const { container, rerender } = render(
      <RovingList rowCount={40} windowStart={0} windowLength={4} onReveal={() => undefined} />,
    );
    const list = listOf(container);
    await pressEnd(list);
    rerender(
      <RovingList rowCount={5} windowStart={0} windowLength={5} onReveal={() => undefined} />,
    );
    // Row 4 is mounted and is the active index; it is still not what was asked for.
    expect(list.querySelector('li[data-index="4"]')).not.toBeNull();
    expect(document.activeElement?.textContent).not.toBe("row 4");
    expect(document.activeElement).toBe(document.body);
  });
});

describe("useWindowedRovingIndex — the roving index controls the real target", () => {
  function listOf(container: HTMLElement): HTMLElement {
    const list = container.querySelector("ul");
    if (list === null) {
      throw new Error("the list did not render");
    }
    return list;
  }

  it("puts one tab stop in the whole list, whatever the window mounted", () => {
    // The defect in terms: the roving index went on the `<li>` and every row's button
    // kept its native stop, so a window of four rows put five stops in the page's tab
    // order and the number moved with the scroll position.
    const { container } = render(
      <RovingList rowCount={40} windowStart={0} windowLength={4} onReveal={() => undefined} />,
    );
    const list = listOf(container);
    expect(list.querySelectorAll("li").length).toBe(4);
    const stops = sequentialTabStops(list);
    expect(stops.map((element) => element.tagName)).toStrictEqual(["BUTTON"]);
    expect(tabbableIndexes(list)).toStrictEqual(["0"]);
  });

  it("moves focus to the next row's control rather than to its wrapper", async () => {
    const { container } = render(
      <RovingList rowCount={40} windowStart={0} windowLength={4} onReveal={() => undefined} />,
    );
    const list = listOf(container);
    await act(async () => {
      list.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(document.activeElement?.tagName).toBe("BUTTON");
    expect(document.activeElement?.textContent).toBe("row 1");
    // And the stop moved with it: still one, now on the row that was moved to.
    expect(tabbableIndexes(list)).toStrictEqual(["1"]);
  });

  it("keeps every inactive row's control out of the tab order", async () => {
    const { container } = render(
      <RovingList rowCount={40} windowStart={0} windowLength={4} onReveal={() => undefined} />,
    );
    const list = listOf(container);
    await act(async () => {
      list.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    const inactive = [...list.querySelectorAll<HTMLElement>("li")].filter(
      (row) => row.dataset["index"] !== "1",
    );
    expect(inactive.length).toBe(3);
    for (const row of inactive) {
      expect(row.querySelector("button")?.getAttribute("tabindex"), row.textContent ?? "").toBe(
        "-1",
      );
    }
  });

  it("negative control: the scan counts a stop that is not the row's declared target", () => {
    // Without this the single-stop claims above would also be satisfied by a scan that
    // matched nothing. A row rendered the old way — content as markup, so the wrapper
    // takes the index and the button keeps its own — is counted as the two stops it is.
    const { container } = render(
      <ul>
        <WindowedListRow as="li" rowIndex={0} totalRowCount={1} isTabbable>
          <button type="button">row 0</button>
        </WindowedListRow>
      </ul>,
    );
    expect(sequentialTabStops(container).map((element) => element.tagName)).toStrictEqual([
      "LI",
      "BUTTON",
    ]);
  });
});
