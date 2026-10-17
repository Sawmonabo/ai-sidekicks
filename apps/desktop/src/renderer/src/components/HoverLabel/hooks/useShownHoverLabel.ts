// Which hover label a window shows, read from its document's pointer and focus. The pointer shows a
// trigger's label the moment it is over the trigger, keeps it while it is over the label itself,
// and drops it once it is over anything else or leaves the window; keyboard focus shows the focused
// trigger's label until focus leaves it, and the pointer's label stands in front of it only while
// the pointer is on another trigger. A press shows a label too, since a touch has no hover and a
// grayed control acts on no press: a click, tap, Enter or Space on a control grayed in place opens
// its label and never reaches the control; a tap opens a label only where a tap does nothing else,
// and on a control a tap acts on a touch held still opens it while the tap still acts, unless a
// held-touch menu answers that hold first. A label a press opened closes on the next press anywhere,
// which goes on to do its own job, as that press goes down, on Escape, on focus leaving it or on a
// scroll, never on a timer.
// Focus inside a trigger, as in a text area whose frame carries the label, shows that trigger's
// label, as the pointer does. The element the pointer and focus are on is kept whether or not it
// carries a label, and the label is read off it again whenever a label attribute changes, so a
// control that gains its words while it is hovered or focused shows them at once, and one that
// drops them drops the label. The pointer's label put away stays away until the pointer moves to
// another trigger or off every trigger. The focused trigger's label put away stays away until focus
// moves, except one held back with the pointer's, which returns once the pointer leaves. A bare
// Escape puts the shown label away. On the focused control's label it does nothing else: the press
// reaches no handler below the document and its default is canceled, so the control's own Escape
// waits for the next press. A label the pointer alone opened goes with the press and leaves it to
// the screen, since focus is elsewhere and the screen's Escape is the one the person meant. A label
// hidden because its trigger scrolled out of view takes no Escape, nor does a press with a modifier
// key or one that ends a text composition.
//
// The elements are kept in refs and the shown label in state that changes only when the trigger,
// its words or its side do, so a pointer sweeping across a page, or a page scrolling under a still
// pointer, re-renders nothing until it reaches a label, and reads the label only when the trigger
// under the pointer changes.

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { isElement } from "@floating-ui/utils/dom";

import {
  HOVER_LABEL_SIDE_ATTRIBUTE,
  HOVER_LABEL_SIDES,
  HOVER_LABEL_TEXT_ATTRIBUTE,
  type HoverLabelSide,
} from "../HoverLabel.js";

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

  // Puts away the label shown. The pointer's label takes the focused control's with it, but only
  // until the pointer leaves, so the focused control's label then comes back.
  const close = useCallback(() => {
    const tracked = trackedRef.current;
    const anchor = shownOf(tracked)?.anchor;
    if (anchor === undefined) {
      return;
    }
    if (anchor === tracked.pressed) {
      tracked.pressed = undefined;
    }
    const focusTrigger = triggerOf(tracked.focus);
    const isPointerLabel = anchor === triggerOf(tracked.pointer);
    if (isPointerLabel) {
      tracked.dismissedPointer = anchor;
    }
    tracked.dismissedFocus = focusTrigger;
    tracked.isFocusHeldByPointer = isPointerLabel && focusTrigger !== anchor;
    readShown();
  }, [readShown]);

  useEffect(() => {
    const tracked = trackedRef.current;
    // The kind of pointer the last press came from, which tells a tap from a click.
    let lastPointerType = "";
    // The trigger whose press-opened label the last pointer press closed as it went down, so the
    // click that ends that press on the same grayed control leaves it closed.
    let pressedBeforePointerDown: Element | undefined;
    const onPointerOver = (event: PointerEvent): void => {
      const { target } = event;
      if (
        event.pointerType === "touch" ||
        !isElement(target) ||
        labelBoxRef.current?.contains(target) === true
      ) {
        return;
      }
      const trigger = triggerOf(target);
      const isSameTrigger = trigger === triggerOf(tracked.pointer);
      tracked.pointer = target;
      const isLeavingDismissed =
        tracked.dismissedPointer !== undefined && tracked.dismissedPointer !== trigger;
      // Rows scrolling under a still pointer cross many elements a second, mostly of one trigger
      // or of none; the label changes only when the trigger does or a put-away label is released.
      if (isSameTrigger && !isLeavingDismissed) {
        return;
      }
      if (isLeavingDismissed) {
        releasePointerDismissal(tracked);
      }
      readShown();
    };
    // A pointer leaving the window is over nothing of it. Only that leaves the root element, so
    // no move or scroll inside the page runs this.
    const onPointerLeave = (): void => {
      tracked.pointer = undefined;
      releasePointerDismissal(tracked);
      readShown();
    };
    const onFocusIn = (event: FocusEvent): void => {
      const { target } = event;
      // Focus from the keyboard only: a click focuses a button too, and the pointer shows it.
      tracked.focus = isElement(target) && target.matches(":focus-visible") ? target : undefined;
      tracked.dismissedFocus = undefined;
      tracked.isFocusHeldByPointer = false;
      readShown();
    };
    // Captured on the document, ahead of the page's own handlers and the tooltip's.
    const onKeyDown = (event: KeyboardEvent): void => {
      const anchor = shownOf(tracked)?.anchor;
      if (
        !isBareEscape(event) ||
        // Escape mid-composition cancels the composition; the label keeps it from no one.
        event.isComposing ||
        anchor === undefined ||
        // A trigger scrolled out of view hides its label, so the key is the page's.
        labelBoxRef.current?.hasAttribute("data-anchor-hidden") === true
      ) {
        return;
      }
      if (anchor === triggerOf(tracked.focus)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      close();
    };
    // The press that a press-opened label waits for closes it and goes on; a press on a grayed
    // control opens that control's label instead and stops there, and on the grayed control whose
    // label is open it only closes it. A tap where a tap does nothing else opens the label too.
    // Captured on the document, ahead of every handler the page and its controls hold.
    const onClick = (event: MouseEvent): void => {
      const { target } = event;
      if (!isElement(target) || labelBoxRef.current?.contains(target) === true) {
        return;
      }
      if (isLiftAfterHold) {
        isLiftAfterHold = false;
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      // A click from the keyboard carries no press count and went down with no pointer.
      const wasPressed =
        tracked.pressed ?? (event.detail > 0 ? pressedBeforePointerDown : undefined);
      pressedBeforePointerDown = undefined;
      tracked.pressed = undefined;
      const grayed = grayedTriggerOf(target);
      if (grayed !== undefined) {
        event.preventDefault();
        event.stopImmediatePropagation();
        tracked.pressed = grayed === wasPressed ? undefined : grayed;
      } else if (lastPointerType === "touch" && target.closest(PRESS_TARGETS) === null) {
        const trigger = triggerOf(target);
        tracked.pressed = trigger === wasPressed ? undefined : trigger;
      }
      readShown();
    };
    // Enter and Space on a grayed control that is no native control, which would turn them into a
    // click, open its label as a click would and reach nothing else.
    const onActivationKey = (event: KeyboardEvent): void => {
      if (
        (event.key !== "Enter" && event.key !== " ") ||
        event.shiftKey ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        !isElement(event.target)
      ) {
        return;
      }
      const grayed = grayedTriggerOf(event.target);
      if (grayed === undefined || grayed.matches(NATIVE_CONTROLS)) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      tracked.pressed = grayed;
      readShown();
    };
    // A touch held still on a trigger opens its label once the hold lasts, unless it moves or
    // lifts first or a held-touch menu answers it; the lift that ends that hold runs nothing.
    // Told from pointer events, since iOS raises no context menu event on a held touch.
    const view = ownerDocument.defaultView;
    let hold: { timer: number; x: number; y: number } | undefined;
    let isLiftAfterHold = false;
    const endHold = (): void => {
      if (hold !== undefined) {
        view?.clearTimeout(hold.timer);
        hold = undefined;
      }
    };
    const onPointerDown = (event: PointerEvent): void => {
      lastPointerType = event.pointerType;
      isLiftAfterHold = false;
      endHold();
      // The next press closes a press-opened label as it goes down, so a press that starts a
      // selection or a drag, or lands on a scrollbar, and raises no click closes it too.
      pressedBeforePointerDown = tracked.pressed;
      if (
        tracked.pressed !== undefined &&
        !(isElement(event.target) && labelBoxRef.current?.contains(event.target) === true)
      ) {
        tracked.pressed = undefined;
        readShown();
      }
      const trigger = isElement(event.target) ? triggerOf(event.target) : undefined;
      if (event.pointerType !== "touch" || trigger === undefined || view === null) {
        return;
      }
      hold = {
        x: event.clientX,
        y: event.clientY,
        timer: view.setTimeout(() => {
          hold = undefined;
          isLiftAfterHold = true;
          tracked.pressed = trigger;
          readShown();
        }, HOLD_MS),
      };
    };
    const onPointerMove = (event: PointerEvent): void => {
      if (
        hold !== undefined &&
        Math.hypot(event.clientX - hold.x, event.clientY - hold.y) > HOLD_SLOP_PX
      ) {
        endHold();
      }
    };
    // A held-touch menu the page draws answers the hold's context menu event first and wins.
    const onContextMenu = (event: MouseEvent): void => {
      if (lastPointerType === "touch" && event.defaultPrevented) {
        endHold();
        if (isLiftAfterHold) {
          isLiftAfterHold = false;
          tracked.pressed = undefined;
          readShown();
        }
      }
    };
    const onScroll = (): void => {
      if (tracked.pressed !== undefined) {
        tracked.pressed = undefined;
        readShown();
      }
    };
    const onFocusOut = (event: FocusEvent): void => {
      if (isElement(event.target) && tracked.pressed?.contains(event.target) === true) {
        tracked.pressed = undefined;
        readShown();
      }
      if (tracked.focus === event.target) {
        tracked.focus = undefined;
        tracked.dismissedFocus = undefined;
        tracked.isFocusHeldByPointer = false;
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
      attributeFilter: [HOVER_LABEL_TEXT_ATTRIBUTE, HOVER_LABEL_SIDE_ATTRIBUTE],
    });
    const root = ownerDocument.documentElement;
    ownerDocument.addEventListener("pointerover", onPointerOver);
    root.addEventListener("pointerleave", onPointerLeave);
    ownerDocument.addEventListener("focusin", onFocusIn);
    ownerDocument.addEventListener("focusout", onFocusOut);
    ownerDocument.addEventListener("keydown", onKeyDown, { capture: true });
    ownerDocument.addEventListener("keydown", onActivationKey, { capture: true });
    ownerDocument.addEventListener("click", onClick, { capture: true });
    ownerDocument.addEventListener("pointerdown", onPointerDown, { capture: true });
    ownerDocument.addEventListener("pointermove", onPointerMove, { capture: true, passive: true });
    ownerDocument.addEventListener("pointerup", endHold, { capture: true });
    ownerDocument.addEventListener("pointercancel", endHold, { capture: true });
    ownerDocument.addEventListener("contextmenu", onContextMenu);
    ownerDocument.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      observer.disconnect();
      ownerDocument.removeEventListener("pointerover", onPointerOver);
      root.removeEventListener("pointerleave", onPointerLeave);
      ownerDocument.removeEventListener("focusin", onFocusIn);
      ownerDocument.removeEventListener("focusout", onFocusOut);
      ownerDocument.removeEventListener("keydown", onKeyDown, { capture: true });
      ownerDocument.removeEventListener("keydown", onActivationKey, { capture: true });
      ownerDocument.removeEventListener("click", onClick, { capture: true });
      endHold();
      ownerDocument.removeEventListener("pointerdown", onPointerDown, { capture: true });
      ownerDocument.removeEventListener("pointermove", onPointerMove, { capture: true });
      ownerDocument.removeEventListener("pointerup", endHold, { capture: true });
      ownerDocument.removeEventListener("pointercancel", endHold, { capture: true });
      ownerDocument.removeEventListener("contextmenu", onContextMenu);
      ownerDocument.removeEventListener("scroll", onScroll, { capture: true });
    };
  }, [ownerDocument, labelBoxRef, readShown, close]);

  return { shown, close };
}

/**
 * The trigger a press opened the label of, the element the pointer is over and the one keyboard
 * focus is on, each possibly absent, with the trigger each showed when its label was put away, and
 * whether the focused trigger's label was put away only along with the pointer's.
 */
interface TrackedElements {
  pressed?: Element | undefined;
  pointer?: Element | undefined;
  focus?: Element | undefined;
  dismissedPointer?: Element | undefined;
  dismissedFocus?: Element | undefined;
  isFocusHeldByPointer?: boolean;
}

// The pointer left the trigger whose label was put away, so that label may show again, and the
// focused trigger's label too where it went away only with the pointer's.
function releasePointerDismissal(tracked: TrackedElements): void {
  tracked.dismissedPointer = undefined;
  if (tracked.isFocusHeldByPointer === true) {
    tracked.dismissedFocus = undefined;
    tracked.isFocusHeldByPointer = false;
  }
}

const TRIGGER_SELECTOR = `[${HOVER_LABEL_TEXT_ATTRIBUTE}]`;

// The trigger an element is on: itself or the trigger around it, as a glyph the pointer is over
// or a field focused inside a labeled frame.
function triggerOf(element: Element | undefined): Element | undefined {
  return element?.closest(TRIGGER_SELECTOR) ?? undefined;
}

// How long a touch stays still on a trigger before it opens the label, and how far it may drift.
const HOLD_MS = 500;
const HOLD_SLOP_PX = 8;

// A press lands on one of these when a tap there does something of its own.
const PRESS_TARGETS =
  'a[href], button, input, select, textarea, label, summary, [role="button"], [role="link"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], [role="tab"], [role="switch"], [role="checkbox"], [role="radio"], [tabindex]:not([tabindex="-1"])';

// The controls whose Enter and Space the browser turns into a click.
const NATIVE_CONTROLS = "a[href], button, input, select, textarea, summary";

// The label of the control grayed in place that an element is in, if that control carries one;
// a label around the grayed control belongs to something else and is not its reason.
function grayedTriggerOf(element: Element): Element | undefined {
  const grayed = element.closest('[aria-disabled="true"]');
  const trigger = triggerOf(element);
  return grayed !== null && trigger !== undefined && grayed.contains(trigger) ? trigger : undefined;
}

function shownOf(tracked: TrackedElements): ShownHoverLabel | undefined {
  const pointerTrigger = triggerOf(tracked.pointer);
  const focusTrigger = triggerOf(tracked.focus);
  const anchor =
    triggerOf(tracked.pressed) ??
    (pointerTrigger === tracked.dismissedPointer ? undefined : pointerTrigger) ??
    (focusTrigger === tracked.dismissedFocus ? undefined : focusTrigger);
  if (anchor === undefined) {
    return undefined;
  }
  return {
    anchor,
    // Present: the trigger selector matched this element.
    text: anchor.getAttribute(HOVER_LABEL_TEXT_ATTRIBUTE) ?? "",
    side: sideOf(anchor.getAttribute(HOVER_LABEL_SIDE_ATTRIBUTE)),
  };
}

function isBareEscape(event: KeyboardEvent): boolean {
  return (
    event.key === "Escape" && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey
  );
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
  return HOVER_LABEL_SIDES.find((side) => side === attribute);
}
