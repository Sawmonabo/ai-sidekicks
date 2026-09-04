// The ancestry an element's POSITION depends on, and every reading taken over it.
//
// `element-motion.ts` holds the readings that are about MOTION — which events
// announce it, which animations could be carrying an element, and the composed
// observer that decides what to do about either. This module holds the other half:
// WHICH BOXES can move this element by being relaid, and how the document says one of
// them has. They are split because they depend on nothing of each other's — nothing
// here reads an animation, and nothing there walks a tree — and because together they
// were one file doing two jobs.
//
// Four readings, and each is a different question about the same set:
//
//   • WHO the ancestry is — every box whose relayout carries this element.
//   • WHO IS BESIDE IT — the siblings whose intrinsic size can grow and push it.
//   • THE CHILD LISTS MOVING — a deck reordering its seats.
//   • THE LAYOUT ATTRIBUTES CHANGING — a width written in one step, which animates
//     nothing and so is heard by no motion source at all.
//
// WHY A SIBLING'S SIZE IS A READING NOTHING ELSE TAKES. A sibling grows because a
// text node was rewritten or because something was inserted deep inside it. Neither
// mutation carries `class` or `style`, so the attribute watch hears nothing; the
// inserted node is not a direct child of any ancestor, so the child-list watch hears
// nothing; and where the ancestor holding both boxes is fixed-size it is not relaid,
// so the ancestor size watch hears nothing either. The element moves and every other
// source is silent.
//
// WHY THAT IS NOT A BROADER MUTATION WATCH. Widening the attribute observer's subtree
// to `characterData` and `childList` would wake this module on every appended row and
// every rewritten label anywhere under the outermost ancestor — on a console with a
// live feed, a forced layout per row, for mutations that move no box at all. A
// `ResizeObserver` over the siblings asks the platform the question that actually
// decides it: a mutation that changed no box reports nothing, and one that changed a
// sibling's box reports exactly once. The set is BOUNDED, nearest sibling first,
// because a sibling count belongs to the document rather than to the element;
// `POSITION_SIBLING_OBSERVER_CAP` states the bound and what is given up past it.

import { POSITION_SIBLING_OBSERVER_CAP, type Unsubscribe } from "../core/index.js";
import { observeElementResize } from "../primitives/index.js";

/** Every ancestor whose relayout can move this element, innermost first. */
export function readPositionAncestry(element: Element): readonly Element[] {
  const boundary = typeof document === "undefined" ? null : document.body;
  const ancestors: Element[] = [];
  for (let ancestor = element.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
    ancestors.push(ancestor);
    if (ancestor === boundary) {
      return ancestors;
    }
  }
  return ancestors;
}

/**
 * Watch one `MutationObserver` over every ancestor's child list.
 *
 * One observer with many targets rather than one per ancestor, because a
 * `MutationObserver` takes targets and a `ResizeObserver` callback would not tell
 * the caller anything more here: every one of these mutations means the same thing.
 */
export function observeAncestorReorder(
  ancestors: readonly Element[],
  onReorder: () => void,
): Unsubscribe {
  if (typeof MutationObserver === "undefined" || ancestors.length === 0) {
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
 * The attributes an INSTANT layout change arrives on.
 *
 * `class` and `style`, and nothing else: those are the two a script writes a box's
 * width through without animating it. A filter of two is also what keeps a
 * document-wide watch from waking on every `aria-expanded`, every `data-` flag, and
 * every `value` the console writes — mutations that move no box at all.
 */
const LAYOUT_ATTRIBUTE_NAMES = ["class", "style"] as const;

/**
 * Watch every `class` and `style` change in the outermost ancestor's subtree.
 *
 * WHY A SECOND OBSERVER RATHER THAN A WIDER OPTION SET ON THE FIRST. A
 * `MutationObserver`'s registration is per node, and a second `observe()` call on a
 * node REPLACES the options the first gave it — so folding `attributes` into the
 * reorder watch means the two questions share one width. Either the attribute arm
 * inherits `subtree: false` and sees no sibling's attribute at all, which is the
 * whole case; or the reorder arm inherits `subtree: true` and fires on every node
 * inserted anywhere in the document, which on a console with a live feed is a
 * forced layout per appended row. Two observers keep each question at the width it
 * needs.
 *
 * WHY THE OUTERMOST ANCESTOR AND NOT EACH OF THEM. The box that moved this element
 * can sit beside ANY ancestor, not only beside the element: a fixed-size sibling of
 * the deck moves the pane exactly as a fixed-size sibling of the pane does, and a
 * subtree rooted at the innermost ancestor contains neither. The outermost ancestor
 * is the one subtree that holds every one of them, and registering the inner ones
 * as well would queue duplicate records for one mutation without covering one more
 * node.
 *
 * WHAT COALESCES A BURST. A `MutationObserver` delivers ONE callback per delivery
 * turn carrying every record queued during it, so fifty class writes in one turn
 * reach `onLayoutAttributeChange` once. The publisher above then takes one reading
 * per call and queues one frame for the write. Nothing on this path reads a layout
 * per mutation, and nothing here reads one at all.
 */
export function observeLayoutAttributes(
  ancestors: readonly Element[],
  onLayoutAttributeChange: () => void,
): Unsubscribe {
  const outermostAncestor = ancestors.at(-1);
  if (typeof MutationObserver === "undefined" || outermostAncestor === undefined) {
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
 * Every box beside this element's ancestry, nearest first and bounded.
 *
 * "Beside" is the element's own siblings and then each ancestor's, which is exactly
 * the set whose intrinsic size can grow without moving anything the other five
 * sources watch. Nearest first because the bound has to cut somewhere and a box
 * beside the pane displaces it further than a box beside the document body does.
 *
 * The ancestors themselves are excluded rather than filtered out afterwards: each one
 * is already watched for size by source 2, and observing it twice would cost a second
 * observer to learn the same fact.
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

/**
 * The size observers over the boxes beside the ancestry, replaced as that set moves.
 *
 * A class because the set is live state with an invariant — one observer per watched
 * box, and none left armed after `dispose` — and `apps/desktop/AGENTS.md` puts
 * stateful logic behind private fields rather than in a closure a caller can only
 * hope was torn down.
 *
 * WHY IT DIFFS RATHER THAN RE-ARMING. A `ResizeObserver` delivers an initial callback
 * for every element it is given, so disconnecting and re-observing the whole set on
 * each reorder would raise an invalidation for every box on the page each time a
 * single row moved. Diffing means an unchanged set costs nothing and a changed one
 * costs exactly the boxes that changed — and the one initial delivery a genuinely new
 * sibling brings is a box the caller has not measured yet, which is a reading it
 * wants rather than noise.
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

  /** How many boxes are armed. Zero after `dispose`, and that is the budget. */
  public get watchedCount(): number {
    return this.#detachersByElement.size;
  }

  public dispose(): void {
    this.watch([]);
  }
}
