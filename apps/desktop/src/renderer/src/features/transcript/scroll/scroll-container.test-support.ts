// A scroll container a test can drive at real geometry: `happy-dom` reports zero for
// `clientHeight`, `scrollHeight` and `scrollTop`.
// The offset lives behind an accessor pair so the fixture is not a second `scrollTop` writer.

import { type ScrollContainer } from "./scroll-chokepoint.js";

/** A `ScrollContainer` with settable geometry that counts scroll listeners. */
export interface CountingScrollContainer extends ScrollContainer {
  readonly scrollListenerCount: number;
  /** Move the offset the way a reader does, and notify the scroll listeners. */
  moveTo(offset: number): void;
  /**
   * Change the reported box the way a pane resize does. No scroll event fires; the
   * controller's overflow pass on the frozen clock is what notices.
   */
  resizeTo(clientHeight: number, scrollHeight: number): void;
}

/** Starting geometry for `createCountingScrollContainer`, in pixels. */
export interface CountingScrollContainerOptions {
  readonly initialScrollTop?: number;
  readonly clientHeight?: number;
  readonly scrollHeight?: number;
}

const DEFAULT_INITIAL_SCROLL_TOP_PX = 40;
const DEFAULT_CLIENT_HEIGHT_PX = 300;
const DEFAULT_SCROLL_HEIGHT_PX = 4000;

/** Builds a `CountingScrollContainer` with the given starting geometry. */
export function createCountingScrollContainer(
  options: CountingScrollContainerOptions = {},
): CountingScrollContainer {
  const scrollListeners: (() => void)[] = [];
  let scrollOffsetPx = options.initialScrollTop ?? DEFAULT_INITIAL_SCROLL_TOP_PX;
  let viewportHeightPx = options.clientHeight ?? DEFAULT_CLIENT_HEIGHT_PX;
  let contentHeightPx = options.scrollHeight ?? DEFAULT_SCROLL_HEIGHT_PX;
  return {
    get scrollTop(): number {
      return scrollOffsetPx;
    },
    set scrollTop(next: number) {
      scrollOffsetPx = next;
    },
    get clientHeight(): number {
      return viewportHeightPx;
    },
    get scrollHeight(): number {
      return contentHeightPx;
    },
    get scrollListenerCount(): number {
      return scrollListeners.length;
    },
    moveTo(offset: number): void {
      scrollOffsetPx = offset;
      for (const listener of [...scrollListeners]) {
        listener();
      }
    },
    resizeTo(clientHeight: number, scrollHeight: number): void {
      viewportHeightPx = clientHeight;
      contentHeightPx = scrollHeight;
    },
    addEventListener(_type: string, listener: () => void): void {
      scrollListeners.push(listener);
    },
    removeEventListener(_type: string, listener: () => void): void {
      const listenerIndex = scrollListeners.indexOf(listener);
      if (listenerIndex >= 0) {
        scrollListeners.splice(listenerIndex, 1);
      }
    },
  };
}
