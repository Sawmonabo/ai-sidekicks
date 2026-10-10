// A scroll container a test can drive at real geometry: a real element, because the controller
// takes one, with its three geometry reads defined onto it, because `happy-dom` reports zero for
// `clientHeight`, `scrollHeight` and `scrollTop`. The offset lives behind an accessor pair so the
// fixture is not a second `scrollTop` writer.

/** A scroll container with settable geometry that counts scroll listeners. */
export interface CountingScrollContainer extends HTMLElement {
  /** How many scroll listeners are attached now. */
  scrollListenerCount(): number;
  /**
   * Move the offset the way a reader does: their wheel, then the scroll it makes, both notified;
   * `inputAtMs`, where given, is both events' own time stamp.
   */
  moveTo(offset: number, inputAtMs?: number): void;
  /**
   * Change the reported box the way a pane resize does. No scroll event fires; the
   * controller's overflow pass on the frozen clock is what notices.
   */
  resizeTo(clientHeight: number, scrollHeight: number): void;
}

/** Starting geometry for `createCountingScrollContainer`, in pixels. */
interface CountingScrollContainerOptions {
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
  const element = document.createElement("div");
  const scrollListeners = new Set<EventListenerOrEventListenerObject>();
  let scrollOffsetPx = options.initialScrollTop ?? DEFAULT_INITIAL_SCROLL_TOP_PX;
  let viewportHeightPx = options.clientHeight ?? DEFAULT_CLIENT_HEIGHT_PX;
  let contentHeightPx = options.scrollHeight ?? DEFAULT_SCROLL_HEIGHT_PX;
  // Configurable, so a test can spy on a read or stand in the platform's clamp for the write.
  Object.defineProperties(element, {
    scrollTop: {
      configurable: true,
      get: () => scrollOffsetPx,
      set: (next: number) => {
        scrollOffsetPx = next;
      },
    },
    clientHeight: { configurable: true, get: () => viewportHeightPx },
    scrollHeight: { configurable: true, get: () => contentHeightPx },
  });
  Object.defineProperties(element, {
    addEventListener: {
      value: (
        type: string,
        listener: EventListenerOrEventListenerObject,
        listenerOptions?: AddEventListenerOptions | boolean,
      ): void => {
        if (type === "scroll") {
          scrollListeners.add(listener);
        }
        HTMLElement.prototype.addEventListener.call(element, type, listener, listenerOptions);
      },
    },
    removeEventListener: {
      value: (
        type: string,
        listener: EventListenerOrEventListenerObject,
        listenerOptions?: EventListenerOptions | boolean,
      ): void => {
        if (type === "scroll") {
          scrollListeners.delete(listener);
        }
        HTMLElement.prototype.removeEventListener.call(element, type, listener, listenerOptions);
      },
    },
  });
  return Object.assign(element, {
    scrollListenerCount: (): number => scrollListeners.size,
    moveTo: (offset: number, inputAtMs?: number): void => {
      // A reader's scroll follows their own input; a wheel that turns no line stands in for it.
      const wheel = new WheelEvent("wheel", { deltaY: 0 });
      const event = new Event("scroll");
      if (inputAtMs !== undefined) {
        Object.defineProperty(wheel, "timeStamp", { value: inputAtMs });
        Object.defineProperty(event, "timeStamp", { value: inputAtMs });
      }
      element.dispatchEvent(wheel);
      scrollOffsetPx = offset;
      element.dispatchEvent(event);
    },
    resizeTo: (clientHeight: number, scrollHeight: number): void => {
      viewportHeightPx = clientHeight;
      contentHeightPx = scrollHeight;
    },
  });
}
