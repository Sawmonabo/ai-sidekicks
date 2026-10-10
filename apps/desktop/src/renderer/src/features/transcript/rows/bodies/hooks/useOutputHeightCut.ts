// Cuts a call's output at a share of the visible flow: the flow's height from the scroll
// controller's geometry, and whether the output runs past the cut. The cut itself is CSS, whole
// lines of the output's own type, so a text size step moves it.

import {
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import type { Unsubscribe } from "#shared/preload-api.js";
import { MarkdownWindowViewportContext } from "../../markdown/block-window/context.js";

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
 * The cut for one output, armed when `isCutAtFlowHeight` and drawn inside a transcript viewport
 * that has measured its flow; anywhere else the output is drawn whole.
 */
export function useOutputHeightCut(isCutAtFlowHeight: boolean): OutputHeightCut {
  const bodyRef = useRef<HTMLPreElement>(null);
  const contentRef = useRef<HTMLSpanElement>(null);
  const [runsPastCut, setRunsPastCut] = useState(false);
  const flowHeightPx = useVisibleFlowHeight();
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
    // its top, where the box's scroll height does not count them. Read once here, so the first
    // frame already draws `Show all` or not, and then from the observer's entries, which force no
    // layout.
    const style = getComputedStyle(body);
    let boxHeightPx =
      body.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    let contentHeightPx = content.getBoundingClientRect().height;
    const readRunsPastCut = (): void => {
      setRunsPastCut(contentHeightPx - boxHeightPx > CUT_TOLERANCE_PX);
    };
    readRunsPastCut();
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === body) {
          boxHeightPx = entry.contentRect.height;
        } else {
          contentHeightPx = entry.contentRect.height;
        }
      }
      readRunsPastCut();
    });
    observer.observe(body);
    observer.observe(content);
    return () => {
      observer.disconnect();
    };
  }, [isArmed]);

  return { bodyRef, contentRef, cutHeightPx, isCut: isArmed && runsPastCut };
}

/** Under half a pixel is the layout's rounding, not a line past the cut. */
const CUT_TOLERANCE_PX = 0.5;

/**
 * The visible flow's height in CSS pixels, from the scroll controller's published geometry;
 * `undefined` outside a transcript viewport or before its first sample. A scroll publishes
 * geometry too, but only a changed height draws again.
 */
function useVisibleFlowHeight(): number | undefined {
  const scrollController = useContext(MarkdownWindowViewportContext)?.scrollController;
  const subscribe = useCallback(
    (onChange: () => void): Unsubscribe =>
      scrollController === undefined
        ? () => undefined
        : scrollController.subscribeToGeometry(onChange),
    [scrollController],
  );
  const flowHeightPx = useSyncExternalStore(
    subscribe,
    () => scrollController?.geometry?.viewportHeight,
  );
  return flowHeightPx === 0 ? undefined : flowHeightPx;
}
