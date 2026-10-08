// Which hover label a window shows, read from its document's pointer and focus. The pointer
// shows a trigger's label the moment it is over the trigger, keeps it while it is over the label
// itself, and drops it once it is over anything else or leaves the window; keyboard focus shows
// the focused trigger's label until focus leaves it, and the pointer's label stands in front of it
// only while the pointer is on another trigger. A touch never shows one, since a touch has no
// hover to end it. The words are read off the trigger while it is shown, so a name that changes
// meanwhile changes in the label too, and a trigger that drops its words drops the label.

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
  const [triggers, setTriggers] = useState<LabelTriggers>(NO_TRIGGERS);
  // Bumped when the shown trigger's words change, so the label reads them again.
  const [, setWordsRevision] = useState(0);

  useEffect(() => {
    const isInLabel = (node: EventTarget | null): boolean =>
      isElement(node) && labelBoxRef.current?.contains(node) === true;
    const onPointerOver = (event: PointerEvent): void => {
      if (event.pointerType === "touch" || !isElement(event.target) || isInLabel(event.target)) {
        return;
      }
      const pointer = event.target.closest(TRIGGER_SELECTOR) ?? undefined;
      setTriggers((current) => (current.pointer === pointer ? current : { ...current, pointer }));
    };
    // A pointer leaving the window is over nothing of it.
    const onPointerOut = (event: PointerEvent): void => {
      if (event.relatedTarget === null) {
        setTriggers((current) => ({ ...current, pointer: undefined }));
      }
    };
    const onFocusIn = (event: FocusEvent): void => {
      if (isInLabel(event.target)) {
        return;
      }
      const focus =
        isElement(event.target) && event.target.matches(FOCUSED_TRIGGER_SELECTOR)
          ? event.target
          : undefined;
      setTriggers((current) => (current.focus === focus ? current : { ...current, focus }));
    };
    const onFocusOut = (event: FocusEvent): void => {
      if (isInLabel(event.relatedTarget)) {
        return;
      }
      setTriggers((current) =>
        current.focus === event.target ? { ...current, focus: undefined } : current,
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

  const anchor = triggers.pointer ?? triggers.focus;
  useEffect(() => {
    if (anchor === undefined) {
      return undefined;
    }
    const observer = new MutationObserver(() => {
      setWordsRevision((revision) => revision + 1);
    });
    observer.observe(anchor, { attributeFilter: [TEXT_ATTRIBUTE, SIDE_ATTRIBUTE] });
    return () => {
      observer.disconnect();
    };
  }, [anchor]);

  const close = useCallback(() => {
    setTriggers(NO_TRIGGERS);
  }, []);

  return { shown: anchor === undefined ? undefined : labelOf(anchor), close };
}

/** The trigger the pointer is on and the one keyboard focus is on, either absent. */
interface LabelTriggers {
  readonly pointer?: Element | undefined;
  readonly focus?: Element | undefined;
}

const NO_TRIGGERS: LabelTriggers = {};

const TEXT_ATTRIBUTE = "data-hover-label";

const SIDE_ATTRIBUTE = "data-hover-label-side";

const TRIGGER_SELECTOR = `[${TEXT_ATTRIBUTE}]`;

// Focus from the keyboard only: a click focuses a button too, and the pointer already shows it.
const FOCUSED_TRIGGER_SELECTOR = `[${TEXT_ATTRIBUTE}]:focus-visible`;

function labelOf(anchor: Element): ShownHoverLabel | undefined {
  const text = anchor.getAttribute(TEXT_ATTRIBUTE);
  if (text === null) {
    return undefined;
  }
  return { anchor, text, side: sideOf(anchor.getAttribute(SIDE_ATTRIBUTE)) };
}

function sideOf(attribute: string | null): HoverLabelSide | undefined {
  return attribute === "top" ||
    attribute === "right" ||
    attribute === "bottom" ||
    attribute === "left"
    ? attribute
    : undefined;
}
