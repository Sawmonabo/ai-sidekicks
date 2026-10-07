// Landing on the control an address names: open the folds around it, glide it to the middle of
// the view, focus it and light it once.
//
// A fold is a Base UI `Collapsible` panel drawn with `hiddenUntilFound`, which marks itself with
// the platform's `hidden="until-found"` and opens on `beforematch`, the event the browser's own
// find-in-page sends it. The landing asks each closed fold around the control to open that way,
// then lands once the panels have opened, since opening is the fold's own state change.
//
// The page may not draw the control on the first commit (a body arriving as its own chunk, or a
// row drawn once its read answers), so a miss watches the page body's mutations and lands when
// the control appears. The watch ends on landing, when the address changes, or at the person's
// first press, scroll or key, since a landing after that would pull the page out from under
// them; a control the page never draws leaves the person on the page. The light is a CSS
// animation whose end clears it, so nothing schedules a timer.

import { getWindow } from "@floating-ui/utils/dom";

import { type Clock } from "#renderer/lib/clock.js";
import { clippingAncestorsOf, overflowAxesOf } from "#renderer/lib/clipping-ancestors.js";
import { ScrollController } from "#renderer/lib/scroll/chokepoint.js";
import { SETTINGS_CONTROL_ATTRIBUTE } from "./control-anchor.js";

/** One arrival on one control: found now, or watched for until it is drawn or abandoned. */
export class SettingsControlLanding {
  readonly #pageBody: HTMLElement;
  readonly #controlId: string;
  readonly #clock: Clock;
  /** The person took over before the control was drawn, so it is no longer landed on. */
  readonly #onPersonInput = (): void => {
    this.stop();
  };
  #mutationObserver: MutationObserver | undefined;
  #isStopped = false;

  public constructor(pageBody: HTMLElement, controlId: string, clock: Clock) {
    this.#pageBody = pageBody;
    this.#controlId = controlId;
    this.#clock = clock;
  }

  public start(): void {
    if (this.#landIfDrawn()) {
      return;
    }
    const ownerWindow = getWindow(this.#pageBody);
    this.#mutationObserver = new ownerWindow.MutationObserver(() => {
      if (this.#landIfDrawn()) {
        this.stop();
      }
    });
    // A fold opening only removes its panel's `hidden`, so attribute changes count as drawing.
    this.#mutationObserver.observe(this.#pageBody, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["hidden"],
    });
    for (const eventType of PERSON_INPUT_EVENTS) {
      ownerWindow.document.addEventListener(eventType, this.#onPersonInput, {
        capture: true,
        passive: true,
      });
    }
  }

  public stop(): void {
    if (this.#isStopped) {
      return;
    }
    this.#isStopped = true;
    if (this.#mutationObserver === undefined) {
      return;
    }
    this.#mutationObserver.disconnect();
    const ownerDocument = this.#pageBody.ownerDocument;
    for (const eventType of PERSON_INPUT_EVENTS) {
      ownerDocument.removeEventListener(eventType, this.#onPersonInput, { capture: true });
    }
  }

  /** Land when the page draws the control outside any closed fold; answers whether it did. */
  #landIfDrawn(): boolean {
    const control = [
      ...this.#pageBody.querySelectorAll<HTMLElement>(`[${SETTINGS_CONTROL_ATTRIBUTE}]`),
    ].find((element) => element.getAttribute(SETTINGS_CONTROL_ATTRIBUTE) === this.#controlId);
    if (control === undefined || askClosedFoldsToOpen(control, this.#pageBody)) {
      return false;
    }
    glideToMiddle(control, this.#clock);
    focusTargetOf(control)?.focus({ preventScroll: true });
    light(control);
    return true;
  }
}

/** The attribute that lights a landed control until its animation ends. */
const LANDED_ATTRIBUTE = "data-settings-landed";

/** What the person does that ends a landing still waiting for its control. */
const PERSON_INPUT_EVENTS = ["pointerdown", "keydown", "wheel"] as const;

/** The `hidden` value a closed fold's panel carries until it is found. */
const CLOSED_FOLD_HIDDEN_VALUE = "until-found";

/** The overflow values of a box the person scrolls. */
const SCROLLING_OVERFLOW_VALUES = ["auto", "scroll", "overlay"] as const;

/**
 * Ask every closed fold between the control and the page body to open, as find-in-page does;
 * answers whether any was closed, so the landing waits for them.
 */
function askClosedFoldsToOpen(control: HTMLElement, pageBody: HTMLElement): boolean {
  let isAnyClosed = false;
  for (
    let ancestor = control.parentElement;
    ancestor !== null && ancestor !== pageBody;
    ancestor = ancestor.parentElement
  ) {
    if (ancestor.getAttribute("hidden") === CLOSED_FOLD_HIDDEN_VALUE) {
      isAnyClosed = true;
      ancestor.dispatchEvent(new Event("beforematch", { bubbles: true }));
    }
  }
  return isAnyClosed;
}

/**
 * Put the control's middle at the middle of the box that scrolls it, through the chokepoint.
 *
 * A controller is held for this one write and released: nothing else on the screen writes this
 * box's offset, so a standing one would only watch it.
 */
function glideToMiddle(control: HTMLElement, clock: Clock): void {
  const ownerDocument = control.ownerDocument;
  const scroller = scrollingAncestorOf(control) ?? ownerDocument.scrollingElement;
  if (!(scroller instanceof getWindow(control).HTMLElement)) {
    return;
  }
  const controlBox = control.getBoundingClientRect();
  // The document's scroller measures from the viewport, whose top is zero; any other box
  // measures from its own top edge.
  const viewTop =
    scroller === ownerDocument.scrollingElement ? 0 : scroller.getBoundingClientRect().top;
  const targetScrollTop =
    scroller.scrollTop +
    (controlBox.top - viewTop) -
    (scroller.clientHeight - controlBox.height) / 2;
  const controller = new ScrollController({ clock });
  controller.attach(scroller);
  controller.glideTo("settings-control-landing", targetScrollTop);
  controller.dispose();
}

/**
 * The nearest ancestor that scrolls the control: one the person may scroll whose content is
 * taller than it. `undefined` when none does and the document scrolls it.
 */
function scrollingAncestorOf(control: HTMLElement): HTMLElement | undefined {
  const ownerWindow = getWindow(control);
  for (const ancestor of clippingAncestorsOf(control)) {
    const { vertical } = overflowAxesOf(ownerWindow.getComputedStyle(ancestor));
    if (
      SCROLLING_OVERFLOW_VALUES.some((value) => value === vertical) &&
      ancestor.scrollHeight > ancestor.clientHeight
    ) {
      return ancestor;
    }
  }
  return undefined;
}

/** The element focus lands on: the control itself where it takes focus, else its first field. */
function focusTargetOf(control: HTMLElement): HTMLElement | undefined {
  const focusableSelector =
    'button, input, select, textarea, a[href], summary, [tabindex]:not([tabindex="-1"])';
  if (control.matches(focusableSelector)) {
    return control;
  }
  return control.querySelector<HTMLElement>(focusableSelector) ?? undefined;
}

/**
 * Light the control until its animation ends. A control lit again is unlit first and its box
 * read, so the animation starts over rather than continuing.
 */
function light(control: HTMLElement): void {
  control.removeAttribute(LANDED_ATTRIBUTE);
  void control.offsetWidth;
  control.setAttribute(LANDED_ATTRIBUTE, "");
  // One shared listener, so a control lit twice holds it once.
  control.addEventListener("animationend", clearLight);
}

function clearLight(animationEvent: Event): void {
  const control = animationEvent.currentTarget;
  // A descendant's own animation ends here too, by bubbling; only the light's end clears it.
  if (!(control instanceof Element) || animationEvent.target !== control) {
    return;
  }
  control.removeAttribute(LANDED_ATTRIBUTE);
  control.removeEventListener("animationend", clearLight);
}
