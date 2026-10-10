// The binding mounted the way the real tree mounts it, over a scroll container whose content is
// the virtualizer's own total, for the suites that drive the binding, the controller and the real
// virtualizer together. `happy-dom` lays nothing out, so the box's `scrollHeight` is what the
// sizer the library writes would give it, and a row "measuring" is the library's `resizeItem`.

import { act, renderHook, type RenderHookResult } from "@testing-library/react";
import { vi } from "vitest";

import { ManualClock } from "#renderer/lib/clock.js";
import { WINDOWED_ROW_INDEX_ATTRIBUTE } from "#renderer/lib/windowed-row-markers.js";
import { type RememberedRowHeights } from "#renderer/store/session/remembered-row-heights.js";
import {
  createCountingScrollContainer,
  type CountingScrollContainer,
} from "#renderer/lib/scroll/container.test-support.js";
import {
  installFakeResizeObserver,
  type FakeResizeObserverControl,
} from "#test/helpers/element/resize.js";
import {
  useTranscriptViewport,
  type TranscriptViewportBinding,
  type UseTranscriptViewportOptions,
} from "./useTranscriptViewport.js";
import { ViewportController } from "../controller.js";
import { CALM, syntheticRows } from "../controller.test-support.js";
import { ROW_HEIGHT_SEED_REM, type RowHeightKind } from "../../rows/height-kind.js";
import type { ViewportRow } from "../snapshot.js";
import { type TranscriptRowVirtualizer } from "../virtualizer-options.js";

/** The box height the mounted viewport reports until a case resizes it. */
export const MOUNTED_VIEWPORT_HEIGHT_PX = 400;

/** How many rows the mounted viewport starts with. */
export const MOUNTED_ROW_COUNT = 20;

/** The width every mounted row is laid out at, until a case narrows the transcript. */
export const MOUNTED_ROW_WIDTH_PX = 720;

/** The height kind every mounted row is drawn as. */
const MOUNTED_ROW_KIND: RowHeightKind = "agent-message";

/** A mounted row's height before it measures: its kind's seed at the document's 16 px root. */
export const MOUNTED_ROW_ESTIMATE_PX: number = ROW_HEIGHT_SEED_REM[MOUNTED_ROW_KIND] * 16;

/** One mounted binding and every object a case drives or reads beneath it. */
export interface MountedViewport {
  readonly binding: RenderHookResult<TranscriptViewportBinding, readonly ViewportRow[]>;
  readonly controller: ViewportController;
  readonly virtualizer: TranscriptRowVirtualizer;
  readonly scrollContainer: CountingScrollContainer;
  readonly clock: ManualClock;
  readonly resizeObserver: FakeResizeObserverControl;
  /** The offset of the bottom of the content, as the content stands now. */
  readonly tailOffsetPx: () => number;
}

/**
 * Mounts `useTranscriptViewport` over `MOUNTED_ROW_COUNT` rows and attaches a scroll container as
 * the real tree does: the box's ref lands before the library's layout effect, so a render follows
 * the attach. `startAt` is where the reader starts, scrolled up to from the tail;
 * `rememberedRowHeights` is the session's record of its row heights, a fresh one when omitted;
 * `preparation` says which rows draw whole, every row when omitted. It stubs `ResizeObserver` and
 * spies on the controller, so the suite restores with `vi.unstubAllGlobals()` and
 * `vi.restoreAllMocks()`.
 */
export function mountViewport(
  startAt: "tail" | number,
  rememberedRowHeights?: RememberedRowHeights,
  preparation?: Pick<UseTranscriptViewportOptions, "isRowPrepared" | "subscribeToRowWork">,
): MountedViewport {
  const resizeObserver = installFakeResizeObserver();
  const boundVirtualizers = vi.spyOn(ViewportController.prototype, "bindVirtualizer");
  const clock = new ManualClock();
  const rows = syntheticRows(MOUNTED_ROW_COUNT);
  const binding = renderHook(
    (currentRows: readonly ViewportRow[]) =>
      useTranscriptViewport({
        clock,
        rows: currentRows,
        ...CALM,
        rememberedRowHeights,
        heightKindOf: mountedRowKind,
        ...preparation,
      }),
    { initialProps: rows },
  );
  const [virtualizer] = boundVirtualizers.mock.calls.at(-1) ?? [];
  const controller = boundVirtualizers.mock.contexts.at(-1);
  if (virtualizer === undefined || !(controller instanceof ViewportController)) {
    throw new Error("the binding bound no virtualizer to a viewport controller");
  }
  const scrollContainer = createCountingScrollContainer({
    initialScrollTop: virtualizer.getTotalSize() - MOUNTED_VIEWPORT_HEIGHT_PX,
    clientHeight: MOUNTED_VIEWPORT_HEIGHT_PX,
  });
  // What the sizer the library writes gives the box: its total, never less than the box.
  Object.defineProperty(scrollContainer, "scrollHeight", {
    configurable: true,
    get: () => Math.max(virtualizer.getTotalSize(), scrollContainer.clientHeight),
  });
  act(() => {
    binding.result.current.attachScrollContainer(scrollContainer);
    binding.rerender(rows);
  });
  // A transcript opens following; only the reader's own scroll up puts them anywhere else.
  if (startAt !== "tail") {
    act(() => {
      scrollContainer.moveTo(startAt);
    });
  }
  return {
    binding,
    controller,
    virtualizer,
    scrollContainer,
    clock,
    resizeObserver,
    tailOffsetPx: () => virtualizer.getTotalSize() - scrollContainer.clientHeight,
  };
}

/**
 * One row's element mounted as the feed mounts it: in the document, marked with its index, at the
 * transcript's width, and handed to the library, which measures it as it lands. The suite empties
 * `document.body` after each case.
 */
export function attachRow(subject: MountedViewport, index: number): HTMLElement {
  const element = document.createElement("div");
  element.setAttribute(WINDOWED_ROW_INDEX_ATTRIBUTE, String(index));
  Object.defineProperty(element, "clientWidth", {
    configurable: true,
    value: MOUNTED_ROW_WIDTH_PX,
  });
  document.body.append(element);
  act(() => {
    subject.binding.result.current.attachRow(element);
  });
  return element;
}

/** The row's border box as the platform's observer reports it, at `widthPx` wide. */
export function reportRowSize(
  subject: MountedViewport,
  element: HTMLElement,
  heightPx: number,
  widthPx: number = MOUNTED_ROW_WIDTH_PX,
): void {
  Object.defineProperty(element, "clientWidth", { configurable: true, value: widthPx });
  act(() => {
    subject.resizeObserver.deliverFor(element, heightPx);
  });
}

/** Every mounted row's height kind; one function, so the binding keeps it across renders. */
function mountedRowKind(): RowHeightKind {
  return MOUNTED_ROW_KIND;
}
