// Which hover label a window shows, read from its document's pointer and focus. The pointer
// shows a trigger's label the moment it is over the trigger, keeps it while it is over the label
// itself, and drops it once it is over anything else or leaves the window; keyboard focus shows
// the focused trigger's label until focus leaves it. A touch never shows one, since a touch has no
// hover to end it.

import { useCallback, useEffect, useState, type RefObject } from "react";
import { isElement } from "@floating-ui/utils/dom";

import type { HoverLabelSide } from "./HoverLabel.js";

/** The label a window shows: its trigger, its words and side, and what opened it. */
export interface ShownHoverLabel {
  readonly anchor: Element;
  readonly text: string;
  readonly side: HoverLabelSide | undefined;
  readonly openedBy: "pointer" | "focus";
}

/** The label `ownerDocument` shows now, if any, and the act that puts it away. */
export interface ShownHoverLabelReading {
  readonly shown: ShownHoverLabel | undefined;
  readonly close: () => void;
}

/**
 * Follows the pointer and keyboard focus over `ownerDocument`'s triggers. `labelBoxRef` is the
 * drawn label's outermost box, which the pointer may cross onto without the label closing.
 */
export function useShownHoverLabel(
  ownerDocument: Document,
  labelBoxRef: RefObject<Element | null>,
): ShownHoverLabelReading {
  const [shown, setShown] = useState<ShownHoverLabel | undefined>(undefined);

  useEffect(() => {
    const onPointerOver = (event: PointerEvent): void => {
      if (event.pointerType === "touch" || !isElement(event.target)) {
        return;
      }
      const target = event.target;
      if (labelBoxRef.current?.contains(target) === true) {
        return;
      }
      const trigger = target.closest(TRIGGER_SELECTOR);
      setShown((current) => {
        if (trigger !== null) {
          return current?.anchor === trigger ? current : labelOf(trigger, "pointer");
        }
        return current?.openedBy === "pointer" ? undefined : current;
      });
    };
    // A pointer leaving the window is over nothing of it.
    const onPointerOut = (event: PointerEvent): void => {
      if (event.relatedTarget === null) {
        setShown((current) => (current?.openedBy === "pointer" ? undefined : current));
      }
    };
    const onFocusIn = (event: FocusEvent): void => {
      const target = event.target;
      if (isElement(target) && target.matches(FOCUSED_TRIGGER_SELECTOR)) {
        setShown(labelOf(target, "focus"));
      }
    };
    const onFocusOut = (event: FocusEvent): void => {
      setShown((current) =>
        current?.openedBy === "focus" && current.anchor === event.target ? undefined : current,
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

  const close = useCallback(() => {
    setShown(undefined);
  }, []);

  return { shown, close };
}

const TRIGGER_SELECTOR = "[data-hover-label]";

// Focus from the keyboard only: a click focuses a button too, and the pointer already shows it.
const FOCUSED_TRIGGER_SELECTOR = "[data-hover-label]:focus-visible";

function labelOf(trigger: Element, openedBy: ShownHoverLabel["openedBy"]): ShownHoverLabel {
  return {
    anchor: trigger,
    text: trigger.getAttribute("data-hover-label") ?? "",
    side: sideOf(trigger.getAttribute("data-hover-label-side")),
    openedBy,
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
