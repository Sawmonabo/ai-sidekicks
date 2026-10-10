// What the reader's keys, wheel, touch and presses on the log ask of the transcript frame. It hears
// them on the scroll container and its document and tells the frame what the reader did; every
// decision about the window, the position and the selection stays with the frame.

import { HOST_SELECTION_KEYS } from "#renderer/services/platform/text-selection/host.js";
import { isChordPress, type KeyChord } from "#renderer/services/platform/text-selection/keys.js";
import { type WindowSide } from "./window-cap.js";

/** What the reader's input asks of the frame, each call made as the input is heard. */
export interface ViewportReaderInputOptions {
  /**
   * The reader acted on the log at `inputAtMs`, which may scroll it, toward `towardSide` when the
   * input says which way.
   */
  readonly noteReaderInput: (inputAtMs: number, towardSide?: WindowSide) => void;
  /** A press in the box began or ended; a selection dragged past an edge scrolls it meanwhile. */
  readonly notePointerDown: (isDown: boolean) => void;
  /** Select All pressed on the log: the whole conversation, not only the rows drawn. */
  readonly selectWholeConversation: () => void;
  /** The platform's press for a view's start, Home among them, on the log: its first row. */
  readonly jumpToHead: () => void;
  /** The platform's press for a view's end, End among them, on the log: its last row, following. */
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
   * The platform's presses for Select All and for a view's start and end pressed on the log
   * itself, and the arrow and page keys pressed at either of its ends. A key pressed in a control
   * inside a row, or already handled, is not the log's, and neither is any other key pressed with
   * a modifier; the browser's own jump is prevented because it lands on an estimated end, and its
   * own Select All because it selects only the rows drawn.
   */
  readonly #onScrollContainerKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented) {
      return;
    }
    // Any key the log hears may scroll it, from the box or from a row the focus sits in.
    this.#options.noteReaderInput(event.timeStamp, keySideOf(event.key));
    if (event.target !== event.currentTarget) {
      return;
    }
    if (isAnyChordPress(event, HOST_SELECTION_KEYS.selectAll)) {
      event.preventDefault();
      this.#options.selectWholeConversation();
    } else if (isAnyChordPress(event, HOST_SELECTION_KEYS.jumps.start)) {
      event.preventDefault();
      this.#options.jumpToHead();
    } else if (isAnyChordPress(event, HOST_SELECTION_KEYS.jumps.end)) {
      event.preventDefault();
      this.#options.jumpToTail();
    } else if (hasModifier(event)) {
      return;
    } else if (event.key === "ArrowUp" || event.key === "PageUp") {
      this.#options.reviewPullAt("head", event.timeStamp);
    } else if (event.key === "ArrowDown" || event.key === "PageDown") {
      this.#options.reviewPullAt("tail", event.timeStamp);
    }
  };

  /** A wheel turned past an end of the log the box already stands at. */
  readonly #onScrollContainerWheel = (event: WheelEvent): void => {
    const side = event.deltaY < 0 ? "head" : event.deltaY > 0 ? "tail" : undefined;
    this.#options.noteReaderInput(event.timeStamp, side);
    if (side !== undefined) {
      this.#options.reviewPullAt(side, event.timeStamp);
    }
  };

  readonly #onScrollContainerTouchStart = (event: TouchEvent): void => {
    this.#options.noteReaderInput(event.timeStamp);
    this.#touchStartYPx = event.touches[0]?.clientY;
  };

  /** A drag past an end of the log the box already stands at: down toward the head, up the tail. */
  readonly #onScrollContainerTouchMove = (event: TouchEvent): void => {
    const touchYPx = event.touches[0]?.clientY;
    const touchStartYPx = this.#touchStartYPx;
    if (touchStartYPx === undefined || touchYPx === undefined || touchYPx === touchStartYPx) {
      this.#options.noteReaderInput(event.timeStamp);
      return;
    }
    const side = touchYPx > touchStartYPx ? "head" : "tail";
    this.#options.noteReaderInput(event.timeStamp, side);
    this.#options.reviewPullAt(side, event.timeStamp);
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

/** Whether `event` is any of `chords`. */
function isAnyChordPress(event: KeyboardEvent, chords: readonly KeyChord[]): boolean {
  return chords.some((chord) => isChordPress(event, chord));
}

/** The side of the log a scrolling key moves the box toward, or `undefined` for another key. */
function keySideOf(key: string): WindowSide | undefined {
  switch (key) {
    case "ArrowUp":
    case "PageUp":
    case "Home":
      return "head";
    case "ArrowDown":
    case "PageDown":
    case "End":
      return "tail";
    default:
      return undefined;
  }
}

/** The document events that end a press on the box: a release, a cancel, a buttonless move. */
const POINTER_RELEASE_EVENTS = ["pointerup", "pointercancel", "pointermove"] as const;
