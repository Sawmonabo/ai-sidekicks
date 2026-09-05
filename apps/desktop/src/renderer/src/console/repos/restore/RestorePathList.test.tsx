// What the path list puts in the document, and what it deliberately leaves out.
//
// The claim worth testing here is not that the paths appear — it is that past the
// threshold the DOM holds a WINDOW rather than the enumeration, which is the only
// reason a whole-worktree restore's overwritten-path list is openable at all. Every
// clean case is paired with the one that would pass if the component stopped
// windowing, or started windowing everything.
//
// HOW A ROW GETS A HEIGHT HERE. The console's unit tier runs under happy-dom, which
// has no layout engine and reports every box as zero; `@tanstack/react-virtual` reads
// the scroller's height and each row's through `offsetHeight`, and against a
// zero-height scroller it correctly answers with an empty window. So a case that
// asserts anything about a rendered row has to say how tall the container is, and the
// shim below is where it says it. It is the same role `panes/diff/diff-layout-fixture.test-support.ts`
// plays for the diff pane; that module keys on the diff's own class names and reads the
// diff's own row height, so the two cannot be one until a lane owns both files and can
// hoist a shared one into `test/console/`.

import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RESTORE_PATH_ROW_HEIGHT_PX,
  RESTORE_PATH_VIRTUALIZATION_THRESHOLD,
  RESTORE_PATH_VISIBLE_ROW_CAP,
} from "../../core/index.js";
import { RestorePathList } from "./RestorePathList.js";

/** The height the shim reports for the windowed enumeration's scroll container. */
const SCROLLER_HEIGHT_PX = RESTORE_PATH_VISIBLE_ROW_CAP * RESTORE_PATH_ROW_HEIGHT_PX;

/**
 * The most rows one window may hold: the container's own, plus the library's
 * default overscan on each side, plus the partially-visible boundary row.
 *
 * Derived from the bounds rather than picked — a window that returned more than this
 * is a list that is not windowing.
 */
const MAXIMUM_WINDOW_ROW_COUNT = RESTORE_PATH_VISIBLE_ROW_CAP + 3;

let restoreOffsetHeight: (() => void) | undefined;

beforeEach(() => {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement): number {
      if (this.classList.contains("meridian-restore-disclosure__path-scroller")) {
        return SCROLLER_HEIGHT_PX;
      }
      return this.tagName === "LI" ? RESTORE_PATH_ROW_HEIGHT_PX : 0;
    },
  });
  restoreOffsetHeight = () => {
    if (original === undefined) {
      Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight");
    } else {
      Object.defineProperty(HTMLElement.prototype, "offsetHeight", original);
    }
  };
});

afterEach(() => {
  restoreOffsetHeight?.();
  restoreOffsetHeight = undefined;
});

/** A run of distinct paths, as long as a case asks for. */
function enumeratedPaths(count: number): readonly string[] {
  return Array.from(
    { length: count },
    (_unused, index) => `build/generated/file-${String(index)}.ts`,
  );
}

function renderedRowCount(container: HTMLElement): number {
  return container.querySelectorAll("li").length;
}

describe("restore path list — past the threshold it holds a window", () => {
  it("puts far fewer rows in the document than the enumeration names", () => {
    const paths = enumeratedPaths(RESTORE_PATH_VIRTUALIZATION_THRESHOLD * 8);
    const { container } = render(
      <RestorePathList label="Overwritten ignored paths" paths={paths} onOpenPath={undefined} />,
    );
    expect(renderedRowCount(container)).toBeGreaterThan(0);
    expect(renderedRowCount(container)).toBeLessThanOrEqual(MAXIMUM_WINDOW_ROW_COUNT);
    expect(renderedRowCount(container)).toBeLessThan(paths.length);
  });

  it("negative control: one path short of the threshold, every row is in the document", () => {
    // Without this, a list that windowed unconditionally would pass the case above
    // while making a three-path enumeration pay for a scroll container.
    const paths = enumeratedPaths(RESTORE_PATH_VIRTUALIZATION_THRESHOLD - 1);
    const { container } = render(
      <RestorePathList label="Divergent gitlinks" paths={paths} onOpenPath={undefined} />,
    );
    expect(renderedRowCount(container)).toBe(paths.length);
    expect(container.querySelector(".meridian-restore-disclosure__path-scroller")).toBeNull();
  });

  it("reports the whole enumeration's length to assistive technology, not the window's", () => {
    const paths = enumeratedPaths(RESTORE_PATH_VIRTUALIZATION_THRESHOLD * 4);
    const { container } = render(
      <RestorePathList label="Overwritten ignored paths" paths={paths} onOpenPath={undefined} />,
    );
    const firstRow = container.querySelector("li");
    expect(firstRow?.getAttribute("aria-setsize")).toBe(String(paths.length));
    expect(firstRow?.getAttribute("aria-posinset")).toBe("1");
  });

  it("bounds the scroll container at the height its two bounds name, and names itself", () => {
    const paths = enumeratedPaths(RESTORE_PATH_VIRTUALIZATION_THRESHOLD);
    const { container } = render(
      <RestorePathList label="Overwritten ignored paths" paths={paths} onOpenPath={undefined} />,
    );
    const scroller = container.querySelector<HTMLElement>(
      ".meridian-restore-disclosure__path-scroller",
    );
    expect(scroller?.style.maxBlockSize).toBe(`${String(SCROLLER_HEIGHT_PX)}px`);
    expect(scroller?.getAttribute("aria-label")).toBe("Overwritten ignored paths");
    // The NO-CONTROL arm: with no diff to open, the rows hold nothing focusable, so
    // the region keeps the one stop it always had. A region that scrolls and cannot be
    // reached from the keyboard is a region half the operators cannot read.
    expect(scroller?.getAttribute("tabindex")).toBe("0");
  });

  it("carries the windowed modifier, which is where the dropped spacing lives", () => {
    // The gap and the leading padding the windowed arithmetic cannot account for are
    // dropped by a class rather than by an inline pair, so the sheet holds the rules
    // beside the ones they override. The class is what a test can see — happy-dom
    // applies no stylesheet — and it is the half that would go missing in a rename.
    const paths = enumeratedPaths(RESTORE_PATH_VIRTUALIZATION_THRESHOLD);
    const { container } = render(
      <RestorePathList label="Overwritten ignored paths" paths={paths} onOpenPath={undefined} />,
    );
    const list = container.querySelector(".meridian-restore-disclosure__paths");
    expect(list?.classList.contains("meridian-restore-disclosure__paths--windowed")).toBe(true);
    // Only the computed offset stays inline; the two dropped rules do not.
    expect((list as HTMLElement | null)?.style.gap).toBe("");
    expect((list as HTMLElement | null)?.style.paddingBlockStart).toBe("");
  });

  it("negative control: the plain list carries the modifier on neither", () => {
    // Without this, the case above would pass over a list that applied the windowed
    // modifier unconditionally — which would take the sheet's inter-row gap away from
    // a three-path enumeration that never windows and never needed to lose it.
    const paths = enumeratedPaths(RESTORE_PATH_VIRTUALIZATION_THRESHOLD - 1);
    const { container } = render(
      <RestorePathList label="Divergent gitlinks" paths={paths} onOpenPath={undefined} />,
    );
    const list = container.querySelector(".meridian-restore-disclosure__paths");
    expect(list).not.toBeNull();
    expect(list?.classList.contains("meridian-restore-disclosure__paths--windowed")).toBe(false);
  });
});

describe("restore path list — a windowed row is still a path row", () => {
  it("opens a windowed path in the diff pane when the mount supplies the navigation", () => {
    const onOpenPath = vi.fn();
    const paths = enumeratedPaths(RESTORE_PATH_VIRTUALIZATION_THRESHOLD * 2);
    const { container } = render(
      <RestorePathList label="Overwritten ignored paths" paths={paths} onOpenPath={onOpenPath} />,
    );
    const firstPathButton = container.querySelector("button");
    expect(firstPathButton).not.toBeNull();
    fireEvent.click(firstPathButton as HTMLElement);
    expect(onOpenPath).toHaveBeenCalledWith(paths[0]);
  });

  it("negative control: a windowed list with no navigation renders no control", () => {
    // The row is written once and both modes render it, so the "offers nothing"
    // property has to hold in the windowed mode as well as the plain one.
    const paths = enumeratedPaths(RESTORE_PATH_VIRTUALIZATION_THRESHOLD * 2);
    const { container } = render(
      <RestorePathList label="Overwritten ignored paths" paths={paths} onOpenPath={undefined} />,
    );
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });
});

describe("restore path list — one tab stop, wherever the window happens to be", () => {
  /** Every element in the document that the tab order would stop on. */
  function tabStops(container: HTMLElement): readonly HTMLElement[] {
    return [...container.querySelectorAll<HTMLElement>("[tabindex]")].filter(
      (element) => element.getAttribute("tabindex") === "0",
    );
  }

  it("puts one stop in the tab order for an enumeration of a hundred openable paths", () => {
    // The defect: every drawn row carried a control and every control was a stop, so
    // the number of stops this region added to the page changed as it scrolled — a
    // reader tabbing past the enumeration walked whichever slice was mounted.
    const paths = enumeratedPaths(100);
    const { container } = render(
      <RestorePathList label="Overwritten ignored paths" paths={paths} onOpenPath={vi.fn()} />,
    );

    // Non-vacuous by construction: several rows ARE mounted, and exactly one of them
    // is reachable by Tab.
    expect(renderedRowCount(container)).toBeGreaterThan(1);
    expect(tabStops(container)).toHaveLength(1);
    // And the stop is the control, not the row and not the region: a stop on the `<li>`
    // would answer Enter with nothing.
    expect(tabStops(container)[0]?.tagName).toBe("BUTTON");
    expect(
      container
        .querySelector(".meridian-restore-disclosure__path-scroller")
        ?.getAttribute("tabindex"),
    ).toBeNull();
  });

  it("moves the stop with the arrow keys, and Home takes it back", () => {
    const paths = enumeratedPaths(100);
    const { container } = render(
      <RestorePathList label="Overwritten ignored paths" paths={paths} onOpenPath={vi.fn()} />,
    );
    const list = container.querySelector(".meridian-restore-disclosure__paths");
    expect(list).not.toBeNull();
    const openingStop = tabStops(container)[0];

    fireEvent.keyDown(list as HTMLElement, { key: "ArrowDown" });

    const movedStop = tabStops(container)[0];
    expect(tabStops(container)).toHaveLength(1);
    expect(movedStop).not.toBe(openingStop);

    fireEvent.keyDown(list as HTMLElement, { key: "Home" });

    expect(tabStops(container)).toHaveLength(1);
    expect(tabStops(container)[0]).toBe(openingStop);
  });

  it("negative control: with no navigation the region is the stop and no row is", () => {
    // Without this the pair above would pass against a list that dropped the region's
    // stop unconditionally — which would leave a scroll region holding nothing
    // focusable unreachable from the keyboard, which is what that stop was always for.
    const paths = enumeratedPaths(100);
    const { container } = render(
      <RestorePathList label="Overwritten ignored paths" paths={paths} onOpenPath={undefined} />,
    );

    const stops = tabStops(container);
    expect(stops).toHaveLength(1);
    expect(stops[0]?.classList.contains("meridian-restore-disclosure__path-scroller")).toBe(true);
  });
});
