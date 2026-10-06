// The ancestry an element's position depends on, and the readings over it. The motion half is
// `element-motion.ts`. A sibling's size is watched with a ResizeObserver because a text rewrite
// or deep insertion grows it with no attribute or child-list change; a wider mutation watch would
// force a layout per row on a live feed. The set is capped (`POSITION_SIBLING_OBSERVER_CAP`).

import { POSITION_SIBLING_OBSERVER_CAP } from "../caps.js";
import type { Unsubscribe } from "#shared/preload-api.js";
import { observeElementResize } from "#renderer/lib/element-resize.js";

/** Every ancestor whose relayout can move this element, innermost first, up to the body. */
export function readPositionAncestry(element: Element): readonly Element[] {
  const boundary = element.ownerDocument.body;
  const ancestors: Element[] = [];
  for (let ancestor = element.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
    ancestors.push(ancestor);
    if (ancestor === boundary) {
      return ancestors;
    }
  }
  return ancestors;
}

/** Watches every ancestor's child list with one `MutationObserver`. */
export function observeAncestorReorder(
  ancestors: readonly Element[],
  onReorder: () => void,
): Unsubscribe {
  if (ancestors.length === 0) {
    return () => undefined;
  }
  const observer = new MutationObserver(() => {
    onReorder();
  });
  for (const ancestor of ancestors) {
    observer.observe(ancestor, { childList: true });
  }
  return () => {
    observer.disconnect();
  };
}

/**
 * The attributes an instant layout change arrives on. Only these two, so the watch does not wake
 * on `aria-*`, `data-*` or `value` writes that move no box.
 */
const LAYOUT_ATTRIBUTE_NAMES = ["class", "style"] as const;

/**
 * The size observers over the boxes beside the ancestry, replaced as that set moves. A class for
 * its invariant: one observer per watched box, none armed after `dispose`. `watch` diffs rather
 * than re-arming, because a `ResizeObserver` delivers an initial callback per observed element
 * and re-observing the whole set would invalidate for every box on each reorder.
 */
export class SiblingSizeObservers {
  readonly #onSizeChange: () => void;
  readonly #detachersByElement = new Map<Element, Unsubscribe>();

  public constructor(onSizeChange: () => void) {
    this.#onSizeChange = onSizeChange;
  }

  /** Watch exactly these boxes, releasing whatever is no longer among them. */
  public watch(siblings: readonly Element[]): void {
    const wanted = new Set(siblings);
    for (const [watched, detach] of this.#detachersByElement) {
      if (!wanted.has(watched)) {
        detach();
        this.#detachersByElement.delete(watched);
      }
    }
    for (const sibling of wanted) {
      if (!this.#detachersByElement.has(sibling)) {
        this.#detachersByElement.set(sibling, observeElementResize(sibling, this.#onSizeChange));
      }
    }
  }

  public dispose(): void {
    this.watch([]);
  }
}

/**
 * Watches every `class` and `style` change in the outermost ancestor's subtree. Separate from
 * the reorder watch because a second `observe()` on a node replaces the first's options, so one
 * registration would either miss sibling attributes or fire on every insertion in the document.
 * The outermost ancestor's subtree holds every box that can sit beside any ancestor; registering
 * inner ones would only queue duplicate records.
 */
export function observeLayoutAttributes(
  ancestors: readonly Element[],
  onLayoutAttributeChange: () => void,
): Unsubscribe {
  const outermostAncestor = ancestors.at(-1);
  if (outermostAncestor === undefined) {
    return () => undefined;
  }
  const observer = new MutationObserver(() => {
    onLayoutAttributeChange();
  });
  observer.observe(outermostAncestor, {
    attributes: true,
    attributeFilter: [...LAYOUT_ATTRIBUTE_NAMES],
    subtree: true,
  });
  return () => {
    observer.disconnect();
  };
}

/**
 * Every box beside this element's ancestry, nearest first and capped. "Beside" means the
 * siblings of the element and of each ancestor; the ancestors themselves are excluded because
 * the ancestor resize source already watches them.
 */
export function readAncestrySiblings(
  element: Element,
  ancestors: readonly Element[],
): readonly Element[] {
  const siblings: Element[] = [];
  const onTheAncestryPath = new Set<Element>([element, ...ancestors]);
  for (const subject of [element, ...ancestors]) {
    for (const sibling of subject.parentElement?.children ?? []) {
      if (onTheAncestryPath.has(sibling)) {
        continue;
      }
      if (siblings.length >= POSITION_SIBLING_OBSERVER_CAP) {
        return siblings;
      }
      siblings.push(sibling);
    }
  }
  return siblings;
}
