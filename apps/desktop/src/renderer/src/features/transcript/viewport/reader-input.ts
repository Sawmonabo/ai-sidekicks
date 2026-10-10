// What the reader's keys, wheel, touch and presses on the log ask of the transcript frame. It hears
// them on the scroll container and its document and tells the frame what the reader did; every
// decision about the window, the position and the selection stays with the frame.

import { HOST_CHORD_PLATFORM, PLATFORM_MODIFIER_TOKEN } from "#renderer/lib/chord-format.js";
import { type WindowSide } from "./window-cap.js";

/** What the reader's input asks of the frame, each call made as the input is heard. */
export interface ViewportReaderInputOptions {
  /** The reader acted on the log at `inputAtMs`, which may scroll it. */
  readonly noteReaderInput: (inputAtMs: number) => void;
  /** A press in the box began or ended; a selection dragged past an edge scrolls it meanwhile. */
  readonly notePointerDown: (isDown: boolean) => void;
  /** Select All pressed on the log: the whole log, not only the rows drawn. */
  readonly selectWholeLog: () => void;
  /** Home pressed on the log: the log's first row. */
  readonly jumpToHead: () => void;
  /** End pressed on the log: the log's last row, following again. */
  readonly jumpToTail: () => void;
  /** The reader pulled toward `side` at `inputAtMs`, which owes a pass where the box stands there. */
  readonly reviewPullAt: (side: WindowSide, inputAtMs: number) => void;
}

/** Hears the reader's input on one scroll container at a time and reports it to the frame. */
export class ViewportReaderInput {
  readonly #options: ViewportReaderInputOptions;
  #scrollContainer: HTMLElement | undefined;
  /** Where the reader's touch on the log started, so the direction of a drag is told. */
  #touchStartYPx: number | undefined;

  /**
   * Home, End and Select All pressed on the log itself, and the arrow and page keys pressed at
   * either of its ends. A key pressed in a control inside a row, or already handled, is not the
   * log's, and neither is any other key pressed with a modifier; the browser's own jump is
   * prevented because it lands on an estimated end, and its own Select All because it selects
   * only the rows drawn.
   */
  readonly #onScrollContainerKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented) {
      return;
    }
    // Any key the log hears may scroll it, from the box or from a row the focus sits in.
    this.#options.noteReaderInput(event.timeStamp);
    if (event.target !== event.currentTarget) {
      return;
    }
    if (isSelectAllPress(event)) {
      event.preventDefault();
      this.#options.selectWholeLog();
      return;
    }
    if (hasModifier(event)) {
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      this.#options.jumpToHead();
    } else if (event.key === "End") {
      event.preventDefault();
      this.#options.jumpToTail();
    } else if (event.key === "ArrowUp" || event.key === "PageUp") {
      this.#options.reviewPullAt("head", event.timeStamp);
    } else if (event.key === "ArrowDown" || event.key === "PageDown") {
      this.#options.reviewPullAt("tail", event.timeStamp);
    }
  };

  /** A wheel turned past an end of the log the box already stands at. */
  readonly #onScrollContainerWheel = (event: WheelEvent): void => {
    this.#options.noteReaderInput(event.timeStamp);
    if (event.deltaY < 0) {
      this.#options.reviewPullAt("head", event.timeStamp);
    } else if (event.deltaY > 0) {
      this.#options.reviewPullAt("tail", event.timeStamp);
    }
  };

  readonly #onScrollContainerTouchStart = (event: TouchEvent): void => {
    this.#options.noteReaderInput(event.timeStamp);
    this.#touchStartYPx = event.touches[0]?.clientY;
  };

  /** A drag past an end of the log the box already stands at: down toward the head, up the tail. */
  readonly #onScrollContainerTouchMove = (event: TouchEvent): void => {
    this.#options.noteReaderInput(event.timeStamp);
    const touchYPx = event.touches[0]?.clientY;
    const touchStartYPx = this.#touchStartYPx;
    if (touchStartYPx === undefined || touchYPx === undefined || touchYPx === touchStartYPx) {
      return;
    }
    this.#options.reviewPullAt(touchYPx > touchStartYPx ? "head" : "tail", event.timeStamp);
  };

  /** A press in the box, where a selection dragged past an edge scrolls it with no other input. */
  readonly #onScrollContainerPointerDown = (): void => {
    this.#options.notePointerDown(true);
  };

  /** The press ends wherever the pointer is; a pointer moving with no button held ended it too. */
  readonly #onDocumentPointerRelease = (event: PointerEvent): void => {
    if (event.type !== "pointermove" || event.buttons === 0) {
      this.#options.notePointerDown(false);
    }
  };

  public constructor(options: ViewportReaderInputOptions) {
    this.#options = options;
  }

  /** Hear the reader's input on `scrollContainer` and its document, in place of any box before. */
  public attach(scrollContainer: HTMLElement): void {
    this.detach();
    scrollContainer.addEventListener("keydown", this.#onScrollContainerKeyDown);
    scrollContainer.addEventListener("wheel", this.#onScrollContainerWheel, { passive: true });
    scrollContainer.addEventListener("touchstart", this.#onScrollContainerTouchStart, {
      passive: true,
    });
    scrollContainer.addEventListener("touchmove", this.#onScrollContainerTouchMove, {
      passive: true,
    });
    scrollContainer.addEventListener("pointerdown", this.#onScrollContainerPointerDown);
    for (const type of POINTER_RELEASE_EVENTS) {
      scrollContainer.ownerDocument.addEventListener(type, this.#onDocumentPointerRelease);
    }
    this.#scrollContainer = scrollContainer;
  }

  /** Stop hearing the box; a press still held on it ends with it. */
  public detach(): void {
    this.#scrollContainer?.removeEventListener("keydown", this.#onScrollContainerKeyDown);
    this.#scrollContainer?.removeEventListener("wheel", this.#onScrollContainerWheel);
    this.#scrollContainer?.removeEventListener("touchstart", this.#onScrollContainerTouchStart);
    this.#scrollContainer?.removeEventListener("touchmove", this.#onScrollContainerTouchMove);
    this.#scrollContainer?.removeEventListener("pointerdown", this.#onScrollContainerPointerDown);
    for (const type of POINTER_RELEASE_EVENTS) {
      this.#scrollContainer?.ownerDocument.removeEventListener(
        type,
        this.#onDocumentPointerRelease,
      );
    }
    this.#options.notePointerDown(false);
    this.#scrollContainer = undefined;
  }
}

/** Whether a key was pressed with a modifier, which makes it a chord rather than a plain key. */
function hasModifier(event: KeyboardEvent): boolean {
  return event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
}

/** The platform's Select All press: its command modifier and A, with no other modifier. */
function isSelectAllPress(event: KeyboardEvent): boolean {
  const isCommandHeld =
    PLATFORM_MODIFIER_TOKEN[HOST_CHORD_PLATFORM] === "Meta"
      ? event.metaKey && !event.ctrlKey
      : event.ctrlKey && !event.metaKey;
  return isCommandHeld && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "a";
}

/** The document events that end a press on the box: a release, a cancel, a buttonless move. */
const POINTER_RELEASE_EVENTS = ["pointerup", "pointercancel", "pointermove"] as const;
