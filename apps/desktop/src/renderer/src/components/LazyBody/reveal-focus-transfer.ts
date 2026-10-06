// Where the keyboard is when a loader-backed body reveals, and where it goes after.
//
// A Suspense reveal deletes the reserved subtree and inserts the loaded one, so focus on the
// pending chrome is lost. The chrome cannot be hoisted out of the suspending subtree because its
// actions, entity and key claims come from the body's own module, so focus is transferred.
//
// Focus moves only when the reveal took it: the holder is gone and nothing else has claimed
// it. A click elsewhere, or a body focusing something on mount, is left alone.

import { isHTMLElement } from "@floating-ui/utils/dom";

/**
 * One mount's focus, carried across its own reveal. Per-mount state, so two panes revealing in
 * one commit each restore their own control.
 */
export class RevealFocusTransfer {
  #reserved: ReservedFocus | undefined;

  /**
   * Remembers where the keyboard was as the reserved region is torn down. Called from the
   * teardown, not a `blur` handler, because not every engine fires blur on removal. The document
   * is the window's the region was drawn in, since each window has its own focus.
   */
  public recordReservedFocus(ownerDocument: Document): void {
    const active = ownerDocument.activeElement;
    this.#reserved =
      isHTMLElement(active) && active !== ownerDocument.body
        ? { element: active, ancestors: ancestorsOf(active), identity: controlIdentity(active) }
        : undefined;
  }

  /**
   * Puts the keyboard back on the same control once the body has landed. It does nothing if
   * nothing was focused, the element is still attached, something else holds focus, or no
   * control with the same identity exists.
   */
  public restoreAfterReveal(): void {
    const reserved = this.#reserved;
    this.#reserved = undefined;
    if (reserved === undefined || reserved.element.isConnected) {
      return;
    }
    if (focusHeldElsewhere(reserved.element, reserved.element.ownerDocument.activeElement)) {
      return;
    }
    const container = reserved.ancestors.find((ancestor) => ancestor.isConnected);
    if (container === undefined) {
      return;
    }
    const replacement = [...container.querySelectorAll<HTMLElement>(reserved.element.tagName)].find(
      (candidate) => controlIdentity(candidate) === reserved.identity,
    );
    replacement?.focus();
  }
}

/** How a control is recognized again after the subtree holding it was replaced. */
interface ReservedFocus {
  /** The element that held focus, kept to ask whether the reveal actually removed it. */
  readonly element: HTMLElement;
  /**
   * Its ancestors, nearest first, read while attached. The first one still connected at restore
   * time is the container the loaded body was inserted into; a detached element cannot find it.
   */
  readonly ancestors: readonly HTMLElement[];
  /**
   * Tag, role and name, resolved at record time because `aria-labelledby` ids detach with the
   * chrome.
   */
  readonly identity: string;
}

/** The accessible name an element publishes, by the three routes this app uses. */
function accessibleName(element: HTMLElement): string {
  const explicit = element.getAttribute("aria-label");
  if (explicit !== null) {
    return explicit.trim();
  }
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy !== null) {
    return labelledBy
      .split(/\s+/u)
      .map((id) => element.ownerDocument.getElementById(id)?.textContent?.trim() ?? "")
      .join(" ")
      .trim();
  }
  return element.textContent?.trim() ?? "";
}

/**
 * What makes one control the same control across the swap: tag, role and accessible name. Minted
 * ids are excluded because `useId` differs between the reserved and loaded chrome.
 */
function controlIdentity(element: HTMLElement): string {
  return [element.tagName, element.getAttribute("role") ?? "", accessibleName(element)].join(
    "\u0000",
  );
}

/** Every ancestor of an attached element, nearest first. */
function ancestorsOf(element: HTMLElement): readonly HTMLElement[] {
  const ancestors: HTMLElement[] = [];
  for (let ancestor = element.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
    ancestors.push(ancestor);
  }
  return ancestors;
}

/**
 * Whether a connected element other than the body or the reserved one holds focus. Engines
 * differ on where focus lands when its holder is removed, so this does not test for the body.
 */
function focusHeldElsewhere(reserved: HTMLElement, active: Element | null): boolean {
  return (
    active !== null &&
    active !== reserved &&
    active.isConnected &&
    active !== reserved.ownerDocument.body
  );
}
