// The shift-presses that move the focus end of a selection in read-only text, and moving it as the
// browser would: the host's own text bindings, each a `Selection.modify` step, and a page step,
// which `Selection.modify` lacks, taken line by line as the browser's own page move takes it.

import { HOST_SELECTION_KEYS } from "#renderer/services/platform/text-selection/host.js";
import type { SelectionGranularity } from "#renderer/services/platform/text-selection/keys.js";

/** How one shift-press moves the focus end. */
export interface SelectionExtension {
  readonly direction: "backward" | "forward";
  readonly granularity: SelectionGranularity;
}

const BACKWARD_KEYS: ReadonlySet<string> = new Set(["ArrowLeft", "ArrowUp", "Home", "PageUp"]);

/** The least share of the page a page step moves. */
const PAGE_STEP_FRACTION = 0.875;
/** The browser's own bound on the lines one page step walks. */
const PAGE_STEP_LINE_LIMIT = 1024;

/**
 * How the shift-press `event` moves the focus end, or `undefined` for any other press, including
 * one with two modifiers beside Shift.
 */
export function extensionOf(event: KeyboardEvent): SelectionExtension | undefined {
  if (!event.shiftKey) {
    return undefined;
  }
  const held = (["alt", "ctrl", "meta"] as const).filter((modifier) => event[`${modifier}Key`]);
  if (held.length > 1) {
    return undefined;
  }
  const bindings = HOST_SELECTION_KEYS.bindings[event.key];
  const granularity = bindings?.[held[0] ?? "none"];
  // With no scroll box focused, the browser's page step moves nothing and the press scrolls.
  if (
    granularity === undefined ||
    (granularity === "page" &&
      pageStepOf((event.target as Node | null)?.ownerDocument ?? document) === undefined)
  ) {
    return undefined;
  }
  return { direction: BACKWARD_KEYS.has(event.key) ? "backward" : "forward", granularity };
}

/**
 * Moves the focus end of `browserSelection` by `extension`. A page step needs a focused scroll
 * box, as the browser's own does, and moves the end by whole lines up to one page of it.
 */
export function extendSelection(browserSelection: Selection, extension: SelectionExtension): void {
  if (extension.granularity !== "page") {
    browserSelection.modify("extend", extension.direction, extension.granularity);
    return;
  }
  const pageStepPx = pageStepOf(browserSelection.focusNode?.ownerDocument ?? document);
  const startY = focusY(browserSelection);
  if (pageStepPx === undefined || startY === undefined) {
    return;
  }
  const sign = extension.direction === "forward" ? 1 : -1;
  for (let line = 0; line < PAGE_STEP_LINE_LIMIT; line += 1) {
    const { focusNode, focusOffset } = browserSelection;
    if (focusNode === null) {
      return;
    }
    browserSelection.modify("extend", extension.direction, "line");
    const nextY = focusY(browserSelection);
    const hasMoved =
      browserSelection.focusNode !== focusNode || browserSelection.focusOffset !== focusOffset;
    if (!hasMoved || nextY === undefined) {
      return;
    }
    if (sign * (nextY - startY) > pageStepPx) {
      browserSelection.extend(focusNode, focusOffset);
      return;
    }
  }
}

/**
 * One page step for the focused element, or `undefined` when it is no scroll box: most of the box
 * or the window, whichever is shorter.
 */
function pageStepOf(ownerDocument: Document): number | undefined {
  const focused = ownerDocument.activeElement;
  const ownerWindow = ownerDocument.defaultView;
  if (!(focused instanceof HTMLElement) || ownerWindow === null) {
    return undefined;
  }
  const overflowY = ownerWindow.getComputedStyle(focused).overflowY;
  if (overflowY !== "auto" && overflowY !== "scroll") {
    return undefined;
  }
  const heightPx = Math.min(focused.clientHeight, ownerWindow.innerHeight);
  return Math.max(heightPx * PAGE_STEP_FRACTION, heightPx - HOST_SELECTION_KEYS.pageOverlapPx, 1);
}

/** The top of the caret at the selection's focus end, or `undefined` where it draws none. */
function focusY(browserSelection: Selection): number | undefined {
  const { focusNode } = browserSelection;
  if (focusNode === null) {
    return undefined;
  }
  const caret = focusNode.ownerDocument?.createRange();
  if (caret === undefined) {
    return undefined;
  }
  caret.setStart(focusNode, browserSelection.focusOffset);
  const [rect] = caret.getClientRects();
  return rect?.top;
}
