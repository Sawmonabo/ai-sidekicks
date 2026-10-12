// Cuts a call's output at a share of the visible flow: the flow's height from the scroll
// controller's geometry, and whether the output runs past the cut. The cut itself is CSS, whole
// lines of the output's own type, so a text size step moves it.

import { getWindow } from "@floating-ui/utils/dom";
import { useContext, useLayoutEffect, useRef, useState } from "react";

import { flushSync } from "react-dom";

import type { Unsubscribe } from "#shared/preload-api.js";
import { watchElementsResize } from "#renderer/lib/element-resize.js";
import { useVisibleFlowHeight } from "#renderer/components/TranscriptBodyViewport/hooks/useVisibleFlowHeight.js";
import { requestLayoutRead } from "#renderer/components/TranscriptBodyViewport/layout-reads.js";
import {
  TranscriptBodyViewportContext,
  type TranscriptBodyViewport,
} from "#renderer/components/TranscriptBodyViewport/context.js";

/**
 * The share of the visible flow a call's output is drawn to before the rest is one press away: a
 * quarter, the height a running command's tail is drawn at, so a row keeps its height when its
 * command settles.
 */
export const OUTPUT_CUT_FLOW_SHARE = 0.25;

/** One output's cut, as `useOutputHeightCut` reads it. */
export interface OutputHeightCut {
  /** The output's box, which the cut is set on. */
  readonly bodyRef: React.RefObject<HTMLPreElement | null>;
  /** The output's content inside the box, measured at its whole height. */
  readonly contentRef: React.RefObject<HTMLSpanElement | null>;
  /** The cut's height in CSS pixels, before it rounds down to whole lines; unset when uncut. */
  readonly cutHeightPx: number | undefined;
  /** Whether the output runs past the cut, so the rest is one press away. */
  readonly isCut: boolean;
}

/**
 * The cut for one output of row `rowKey`, armed when `isCutAtFlowHeight` and drawn inside a
 * transcript viewport that has measured its flow; anywhere else the output is drawn whole.
 */
export function useOutputHeightCut(isCutAtFlowHeight: boolean, rowKey: string): OutputHeightCut {
  const bodyRef = useRef<HTMLPreElement>(null);
  const contentRef = useRef<HTMLSpanElement>(null);
  const [runsPastCut, setRunsPastCut] = useState(false);
  const viewport = useContext(TranscriptBodyViewportContext);
  // Outside a viewport there is no flow to cut at, so the output is drawn whole.
  const flowHeightPx = useVisibleFlowHeight(null);
  const cutHeightPx =
    isCutAtFlowHeight && flowHeightPx !== undefined
      ? flowHeightPx * OUTPUT_CUT_FLOW_SHARE
      : undefined;
  const isArmed = cutHeightPx !== undefined;

  useLayoutEffect(() => {
    const body = bodyRef.current;
    const content = contentRef.current;
    if (!isArmed || body === null || content === null) {
      return undefined;
    }
    // The box stops growing at the cut while its content grows on, so both are watched: the
    // content for output arriving, the box for the cut moving with the flow or the text size.
    // The content is read against the box's own content height, since a tail's lines run past
    // its top, where the box's scroll height does not count them. The watch's reports force no
    // layout.
    let boxHeightPx = 0;
    let contentHeightPx = 0;
    const readRunsPastCut = (): void => {
      setRunsPastCut(contentHeightPx - boxHeightPx > CUT_TOLERANCE_PX);
    };
    const readFirstAnswer = (): void => {
      const style = getComputedStyle(body);
      boxHeightPx =
        body.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      contentHeightPx = content.getBoundingClientRect().height;
      readRunsPastCut();
    };
    // A row reads both heights once the commit is done, with every other output the commit
    // brought in, laying the inserted rows out once, so the conversation measures the row with
    // `Show all` in the first frame and no row is drawn over it. A row a screen above the box waits
    // for its first report instead, unless a scroll brings it into the box or past it first, which
    // reads it at once in the same way, before the frame lays out. Still above the box at the
    // report, it draws the answer as the next frame starts, before that frame lays out, so the
    // conversation measures the row with `Show all` there and no frame shows it in the box
    // without; drawn inside the report, the row would grow while its own report waits behind the
    // cut's, which the browser raises as a resize loop. A row that reached the box at the report
    // with no scroll draws the answer inside it, before the frame paints.
    let isFirstReportDeferred = viewport !== undefined && isRowScreensAboveBox(viewport, rowKey, 1);
    let cancelFirstRead = isFirstReportDeferred ? undefined : requestLayoutRead(readFirstAnswer);
    let stopWatchingScroll: Unsubscribe | undefined;
    // The first answer no longer waits, so the scroll has nothing more to tell this row.
    const endFirstReportDeferral = (): void => {
      isFirstReportDeferred = false;
      stopWatchingScroll?.();
      stopWatchingScroll = undefined;
    };
    if (isFirstReportDeferred && viewport !== undefined) {
      const unsubscribe = viewport.scrollController.subscribeToGeometry(() => {
        if (isFirstReportDeferred && !isRowScreensAboveBox(viewport, rowKey, 0)) {
          endFirstReportDeferral();
          cancelFirstRead = requestLayoutRead(readFirstAnswer);
        }
      });
      // Subscribing replays the last sample, which may already have ended the wait.
      if (isFirstReportDeferred) {
        stopWatchingScroll = unsubscribe;
      } else {
        unsubscribe();
      }
    }
    const view = getWindow(body);
    let deferredDrawFrame: number | undefined;
    const watch = watchElementsResize(view, (entries) => {
      for (const entry of entries) {
        if (entry.target === body) {
          boxHeightPx = entry.contentRect.height;
        } else {
          contentHeightPx = entry.contentRect.height;
        }
      }
      if (isFirstReportDeferred) {
        endFirstReportDeferral();
        if (viewport !== undefined && isRowScreensAboveBox(viewport, rowKey, 0)) {
          deferredDrawFrame = view.requestAnimationFrame(() => {
            deferredDrawFrame = undefined;
            flushSync(readRunsPastCut);
          });
        } else {
          flushSync(readRunsPastCut);
        }
      } else {
        readRunsPastCut();
      }
    });
    watch.observe(body);
    watch.observe(content);
    return () => {
      cancelFirstRead?.();
      stopWatchingScroll?.();
      if (deferredDrawFrame !== undefined) {
        view.cancelAnimationFrame(deferredDrawFrame);
      }
      watch.disconnect();
    };
  }, [isArmed, viewport, rowKey]);

  return { bodyRef, contentRef, cutHeightPx, isCut: isArmed && runsPastCut };
}

/** Under half a pixel is the layout's rounding, not a line past the cut. */
const CUT_TOLERANCE_PX = 0.5;

/**
 * Whether row `rowKey` ends `screenCount` screens or more above the conversation's box, at the
 * height the conversation lays it out at. Measured or estimated, that end is where the row's
 * `Show all` would land a frame late: the conversation holds the reader's place through any resize
 * of a row wholly above its box, and a follower's on the tail, so neither a wrong estimate nor the
 * late `Show all` moves the row toward the box. A row below the box is read at once: rows between
 * it and the box move it as they are measured. Reads no element.
 */
function isRowScreensAboveBox(
  viewport: TranscriptBodyViewport,
  rowKey: string,
  screenCount: number,
): boolean {
  const scrollTop = viewport.scrollController.geometry?.scrollTop;
  const viewportHeight = viewport.scrollController.geometry?.viewportHeight;
  const rowEndPx = viewport.rowEndPx(rowKey);
  return (
    scrollTop !== undefined &&
    viewportHeight !== undefined &&
    rowEndPx !== undefined &&
    rowEndPx <= scrollTop - screenCount * viewportHeight
  );
}
