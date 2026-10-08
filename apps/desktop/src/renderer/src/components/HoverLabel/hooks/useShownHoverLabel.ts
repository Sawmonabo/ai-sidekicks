// Which hover label a window shows, read from its document's pointer and focus. The pointer shows a
// trigger's label the moment it is over the trigger, keeps it while it is over the label itself,
// and drops it once it is over anything else or leaves the window; keyboard focus shows the focused
// trigger's label until focus leaves it, and the pointer's label stands in front of it only while
// the pointer is on another trigger. A touch never shows one, since a touch has no hover to end it.
// Focus inside a trigger, as in a text area whose frame carries the label, shows that trigger's
// label, as the pointer does. The element the pointer and focus are on is kept whether or not it
// carries a label, and the label is read off it again whenever a label attribute changes, so a
// control that gains its words while it is hovered or focused shows them at once, and one that
// drops them drops the label. A label put away stays away until the pointer moves to another
// trigger or off every trigger, or focus moves.
//
// The elements are kept in refs and the shown label in state that changes only when the trigger,
// its words or its side do, so a pointer sweeping across a page re-renders nothing until it
// reaches a label.

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { isElement } from "@floating-ui/utils/dom";

import type { HoverLabelSide } from "../HoverLabel.js";

/** The label a window shows: its trigger, its words and the side it prefers. */
export interface ShownHoverLabel {
  readonly anchor: Element;
  readonly text: string;
  readonly side: HoverLabelSide | undefined;
}

/** The label `ownerDocument` shows now, if any, and the act that puts it away. */
export interface ShownHoverLabelReading {
  readonly shown: ShownHoverLabel | undefined;
  readonly close: () => void;
}

/**
 * Follows the pointer and keyboard focus over `ownerDocument`'s triggers. `labelBoxRef` is the
 * drawn label's outermost box, which the pointer may move onto without the label closing.
 */
export function useShownHoverLabel(
  ownerDocument: Document,
  labelBoxRef: RefObject<Element | null>,
): ShownHoverLabelReading {
  const trackedRef = useRef<TrackedElements>({});
  const [shown, setShown] = useState<ShownHoverLabel | undefined>(undefined);

  // Reads the label off the tracked elements, keeping the state as it was when nothing changed.
  const readShown = useCallback(() => {
    const next = shownOf(trackedRef.current);
    setShown((current) => (isSameLabel(current, next) ? current : next));
  }, []);

  useEffect(() => {
    const tracked = trackedRef.current;
    const onPointerOver = (event: PointerEvent): void => {
      const { target } = event;
      if (
        event.pointerType === "touch" ||
        !isElement(target) ||
        labelBoxRef.current?.contains(target) === true
      ) {
        return;
      }
      tracked.pointer = target;
      if (tracked.dismissedPointer !== pointerTriggerOf(target)) {
        tracked.dismissedPointer = undefined;
      }
      readShown();
    };
    // A pointer leaving the window is over nothing of it.
    const onPointerOut = (event: PointerEvent): void => {
      if (event.relatedTarget === null) {
        tracked.pointer = undefined;
        tracked.dismissedPointer = undefined;
        readShown();
      }
    };
    const onFocusIn = (event: FocusEvent): void => {
      const { target } = event;
      // Focus from the keyboard only: a click focuses a button too, and the pointer shows it.
      tracked.focus = isElement(target) && target.matches(":focus-visible") ? target : undefined;
      tracked.dismissedFocus = undefined;
      readShown();
    };
    const onFocusOut = (event: FocusEvent): void => {
      if (tracked.focus === event.target) {
        tracked.focus = undefined;
        tracked.dismissedFocus = undefined;
        readShown();
      }
    };
    // A label can appear on any element above the pointer, which no listener has seen, so one
    // observer watches the document's label attributes for the hook's whole life.
    const observer = new MutationObserver((records) => {
      const { pointer, focus } = tracked;
      if (
        records.some(
          (record) =>
            record.target.contains(focus ?? null) || record.target.contains(pointer ?? null),
        )
      ) {
        readShown();
      }
    });
    observer.observe(ownerDocument, {
      subtree: true,
      attributeFilter: [TEXT_ATTRIBUTE, SIDE_ATTRIBUTE],
    });
    ownerDocument.addEventListener("pointerover", onPointerOver);
    ownerDocument.addEventListener("pointerout", onPointerOut);
    ownerDocument.addEventListener("focusin", onFocusIn);
    ownerDocument.addEventListener("focusout", onFocusOut);
    return () => {
      observer.disconnect();
      ownerDocument.removeEventListener("pointerover", onPointerOver);
      ownerDocument.removeEventListener("pointerout", onPointerOut);
      ownerDocument.removeEventListener("focusin", onFocusIn);
      ownerDocument.removeEventListener("focusout", onFocusOut);
    };
  }, [ownerDocument, labelBoxRef, readShown]);

  const close = useCallback(() => {
    const tracked = trackedRef.current;
    tracked.dismissedPointer = pointerTriggerOf(tracked.pointer);
    tracked.dismissedFocus = focusTriggerOf(tracked.focus);
    readShown();
  }, [readShown]);

  return { shown, close };
}

/**
 * The element the pointer is over and the one keyboard focus is on, either absent, with the
 * trigger each showed when its label was put away.
 */
interface TrackedElements {
  pointer?: Element | undefined;
  focus?: Element | undefined;
  dismissedPointer?: Element | undefined;
  dismissedFocus?: Element | undefined;
}

const TEXT_ATTRIBUTE = "data-hover-label";

const SIDE_ATTRIBUTE = "data-hover-label-side";

const TRIGGER_SELECTOR = `[${TEXT_ATTRIBUTE}]`;

// The pointer is on a trigger while it is over the trigger or anything inside it, such as a glyph.
function pointerTriggerOf(pointer: Element | undefined): Element | undefined {
  return pointer?.closest(TRIGGER_SELECTOR) ?? undefined;
}

function focusTriggerOf(focus: Element | undefined): Element | undefined {
  return focus?.closest(TRIGGER_SELECTOR) ?? undefined;
}

function shownOf(tracked: TrackedElements): ShownHoverLabel | undefined {
  const pointerTrigger = pointerTriggerOf(tracked.pointer);
  const focusTrigger = focusTriggerOf(tracked.focus);
  const anchor =
    (pointerTrigger === tracked.dismissedPointer ? undefined : pointerTrigger) ??
    (focusTrigger === tracked.dismissedFocus ? undefined : focusTrigger);
  if (anchor === undefined) {
    return undefined;
  }
  return {
    anchor,
    // Present: the trigger selector matched this element.
    text: anchor.getAttribute(TEXT_ATTRIBUTE) ?? "",
    side: sideOf(anchor.getAttribute(SIDE_ATTRIBUTE)),
  };
}

function isSameLabel(
  current: ShownHoverLabel | undefined,
  next: ShownHoverLabel | undefined,
): boolean {
  return (
    current?.anchor === next?.anchor && current?.text === next?.text && current?.side === next?.side
  );
}

function sideOf(attribute: string | null): HoverLabelSide | undefined {
  return attribute === "top" ||
    attribute === "right" ||
    attribute === "bottom" ||
    attribute === "left"
    ? attribute
    : undefined;
}
