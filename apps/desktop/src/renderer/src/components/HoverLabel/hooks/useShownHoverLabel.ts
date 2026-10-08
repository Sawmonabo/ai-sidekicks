// Which hover label a window shows, read from its document's pointer and focus. The pointer
// shows a trigger's label the moment it is over the trigger, keeps it while it is over the label
// itself, and drops it once it is over anything else or leaves the window; keyboard focus shows
// the focused trigger's label until focus leaves it, and the pointer's label stands in front of it
// only while the pointer is on another trigger. A touch never shows one, since a touch has no
// hover to end it. The element the pointer and focus are on is kept whether or not it carries a
// label, and the label is read off it at each render, so a control that gains its words while it
// is hovered or focused shows them at once, and one that drops them drops the label. A label put
// away stays away until the pointer moves to another trigger or off every trigger, or focus moves.

import { useCallback, useEffect, useState, type RefObject } from "react";
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
 * drawn label's outermost box, which the pointer and focus may move onto without the label closing.
 */
export function useShownHoverLabel(
  ownerDocument: Document,
  labelBoxRef: RefObject<Element | null>,
): ShownHoverLabelReading {
  const [tracked, setTracked] = useState<TrackedElements>(NOTHING_TRACKED);
  // Bumped when a label attribute changes on or above a tracked element, so it is read again.
  const [, setWordsRevision] = useState(0);

  useEffect(() => {
    const isInLabel = (node: EventTarget | null): boolean =>
      isElement(node) && labelBoxRef.current?.contains(node) === true;
    const onPointerOver = (event: PointerEvent): void => {
      if (event.pointerType === "touch" || !isElement(event.target) || isInLabel(event.target)) {
        return;
      }
      const pointer = event.target;
      setTracked((current) => ({
        ...current,
        pointer,
        dismissedPointer:
          current.dismissedPointer === pointerTriggerOf(pointer)
            ? current.dismissedPointer
            : undefined,
      }));
    };
    // A pointer leaving the window is over nothing of it.
    const onPointerOut = (event: PointerEvent): void => {
      if (event.relatedTarget === null) {
        setTracked((current) => ({ ...current, pointer: undefined, dismissedPointer: undefined }));
      }
    };
    const onFocusIn = (event: FocusEvent): void => {
      if (isInLabel(event.target)) {
        return;
      }
      // Focus from the keyboard only: a click focuses a button too, and the pointer shows it.
      const focus =
        isElement(event.target) && event.target.matches(":focus-visible")
          ? event.target
          : undefined;
      setTracked((current) => ({ ...current, focus, dismissedFocus: undefined }));
    };
    const onFocusOut = (event: FocusEvent): void => {
      if (isInLabel(event.relatedTarget)) {
        return;
      }
      setTracked((current) =>
        current.focus === event.target
          ? { ...current, focus: undefined, dismissedFocus: undefined }
          : current,
      );
    };
    ownerDocument.addEventListener("pointerover", onPointerOver);
    ownerDocument.addEventListener("pointerout", onPointerOut);
    ownerDocument.addEventListener("focusin", onFocusIn);
    ownerDocument.addEventListener("focusout", onFocusOut);
    return () => {
      ownerDocument.removeEventListener("pointerover", onPointerOver);
      ownerDocument.removeEventListener("pointerout", onPointerOut);
      ownerDocument.removeEventListener("focusin", onFocusIn);
      ownerDocument.removeEventListener("focusout", onFocusOut);
    };
  }, [ownerDocument, labelBoxRef]);

  const { pointer, focus } = tracked;
  useEffect(() => {
    if (pointer === undefined && focus === undefined) {
      return undefined;
    }
    // One observer over the document while anything is tracked: the pointer's trigger may be any
    // element above it, so a label can appear on an element no listener has seen.
    const observer = new MutationObserver((records) => {
      const isTrackedChange = records.some(
        (record) => record.target === focus || record.target.contains(pointer ?? null),
      );
      if (isTrackedChange) {
        setWordsRevision((revision) => revision + 1);
      }
    });
    observer.observe(ownerDocument, {
      subtree: true,
      attributeFilter: [TEXT_ATTRIBUTE, SIDE_ATTRIBUTE],
    });
    return () => {
      observer.disconnect();
    };
  }, [ownerDocument, pointer, focus]);

  const close = useCallback(() => {
    setTracked((current) => ({
      ...current,
      dismissedPointer: pointerTriggerOf(current.pointer),
      dismissedFocus: focusTriggerOf(current.focus),
    }));
  }, []);

  const pointerTrigger = pointerTriggerOf(pointer);
  const focusTrigger = focusTriggerOf(focus);
  const anchor =
    (pointerTrigger === tracked.dismissedPointer ? undefined : pointerTrigger) ??
    (focusTrigger === tracked.dismissedFocus ? undefined : focusTrigger);
  return { shown: anchor === undefined ? undefined : labelOf(anchor), close };
}

/**
 * The element the pointer is over and the one keyboard focus is on, either absent, with the
 * trigger each showed when its label was put away.
 */
interface TrackedElements {
  readonly pointer?: Element | undefined;
  readonly focus?: Element | undefined;
  readonly dismissedPointer?: Element | undefined;
  readonly dismissedFocus?: Element | undefined;
}

const NOTHING_TRACKED: TrackedElements = {};

const TEXT_ATTRIBUTE = "data-hover-label";

const SIDE_ATTRIBUTE = "data-hover-label-side";

const TRIGGER_SELECTOR = `[${TEXT_ATTRIBUTE}]`;

// The pointer is on a trigger while it is over the trigger or anything inside it, such as a glyph.
function pointerTriggerOf(pointer: Element | undefined): Element | undefined {
  return pointer?.closest(TRIGGER_SELECTOR) ?? undefined;
}

function focusTriggerOf(focus: Element | undefined): Element | undefined {
  return focus?.matches(TRIGGER_SELECTOR) === true ? focus : undefined;
}

// Called only on an element the trigger selector matched, so the words attribute is present.
function labelOf(anchor: Element): ShownHoverLabel {
  return {
    anchor,
    text: anchor.getAttribute(TEXT_ATTRIBUTE) ?? "",
    side: sideOf(anchor.getAttribute(SIDE_ATTRIBUTE)),
  };
}

function sideOf(attribute: string | null): HoverLabelSide | undefined {
  return attribute === "top" ||
    attribute === "right" ||
    attribute === "bottom" ||
    attribute === "left"
    ? attribute
    : undefined;
}
