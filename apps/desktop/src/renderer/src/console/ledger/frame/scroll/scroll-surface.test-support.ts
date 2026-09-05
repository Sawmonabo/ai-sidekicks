// A scroll surface a test can drive, at geometry a DOM shim cannot answer.
//
// `happy-dom` reports zero for `clientHeight`, `scrollHeight`, and `scrollTop`, so a
// case about where the reader is standing would pass over a viewport with no
// dimensions at all. This is the layout engine's stand-in and never the stand-in for
// a module under test: the chokepoint, the controller, the measurement ledger, and
// the virtualizer bound to them are all the shipped ones.
//
// It lives beside the frame rather than in `test/console/` because it is this
// family's own scaffolding — the surface shape is `scroll-chokepoint.ts`' — and two
// modules in this directory need it.
//
// The offset is held in a closure and reached through an accessor pair rather than a
// plain field, for a reason worth stating: this module is inside the console tree the
// architecture tier scans, and that scan reads text. A fixture assigning the offset
// by name would be indistinguishable from a second scroll writer, and the honest
// answer is not to exempt the file but to write the field once, where the surface's
// own accessor already is.

import { type LedgerScrollSurface } from "./scroll-chokepoint.js";

export interface CountingSurface extends LedgerScrollSurface {
  readonly scrollListenerCount: number;
  /** Move the offset the way a reader does, and tell the listeners about it. */
  moveTo(offset: number): void;
  /**
   * Change the box the surface reports, the way a window or pane resize does — and
   * tell nobody, because a resize fires no scroll event. What notices is the
   * controller's own overflow pass, which a caller drives on the frozen clock.
   */
  resizeTo(clientHeight: number, scrollHeight: number): void;
}

export interface CountingSurfaceOptions {
  readonly initialScrollTop?: number;
  readonly clientHeight?: number;
  readonly scrollHeight?: number;
}

const DEFAULT_INITIAL_SCROLL_TOP_PX = 40;
const DEFAULT_CLIENT_HEIGHT_PX = 300;
const DEFAULT_SCROLL_HEIGHT_PX = 4000;

export function countingSurface(options: CountingSurfaceOptions = {}): CountingSurface {
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
