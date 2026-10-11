// Binds the library's virtualizer to a React list whose items are placed without a render: as the
// virtualizer moves them, each drawn item's offset and the list's total height are written to the
// page directly, and the list renders again only when the items it draws change. A move that keeps
// the same items drawn (a scroll inside the drawn band, an item measuring, the offset a hold
// writes) costs no render. A list with no container attached is written nothing, and renders only
// for a change of the items it draws.

import { Virtualizer, type VirtualItem, type VirtualizerOptions } from "@tanstack/virtual-core";
import { useInsertionEffect, useLayoutEffect, useReducer, useState } from "react";

/** The virtualizer, with the ref of the container its total height is written onto. */
export type DirectlyPlacedVirtualizer<
  TScrollElement extends Element,
  TItemElement extends HTMLElement,
> = Virtualizer<TScrollElement, TItemElement> & {
  /** The element sized to the list's total height; with none attached nothing is written. */
  readonly containerRef: (element: HTMLElement | null) => void;
};

/**
 * A virtualizer over `options` whose items are placed by a transform written to each drawn item,
 * which renders the calling component again only when the indexes it draws, or whether it is
 * scrolling, change. An `onChange` in `options` is called after each change, as the library calls
 * it.
 */
export function useDirectlyPlacedVirtualizer<
  TScrollElement extends Element,
  TItemElement extends HTMLElement,
>(
  options: VirtualizerOptions<TScrollElement, TItemElement>,
): DirectlyPlacedVirtualizer<TScrollElement, TItemElement> {
  const [, redraw] = useReducer(countRedraws, 0);
  const [placement] = useState(() => new DirectPlacement<TScrollElement, TItemElement>());
  const resolvedOptions: VirtualizerOptions<TScrollElement, TItemElement> = {
    ...options,
    onChange: (instance, sync) => {
      placement.placeAll(instance);
      if (placement.drawsAnew(instance)) {
        redraw();
      }
      options.onChange?.(instance, sync);
    },
  };
  const [virtualizer] = useState(() => placement.bind(new Virtualizer(resolvedOptions)));
  virtualizer.setOptions(resolvedOptions);
  // What this render drew, held as it commits: a change after it renders again only when it draws
  // other items. Held before any layout effect or ref, which can measure an item and ask.
  useInsertionEffect(() => {
    placement.noteDrawn(virtualizer);
  });

  useLayoutEffect(() => virtualizer._didMount(), [virtualizer]);
  useLayoutEffect(() => {
    placement.placeTotalSize(virtualizer);
    virtualizer._willUpdate();
  });
  useLayoutEffect(() => {
    placement.placeAll(virtualizer);
  });
  return virtualizer;
}

/** What has been written to the page, and the items the last commit drew. */
class DirectPlacement<TScrollElement extends Element, TItemElement extends HTMLElement> {
  #container: HTMLElement | null = null;
  #totalSizePx: number | undefined;
  /** The offset last written to each item, keyed by element so a remounted item is written anew. */
  #offsetsPx = new WeakMap<Element, number>();
  #drawn: { readonly indexes: readonly number[]; readonly isScrolling: boolean } | undefined;

  /**
   * Gives `virtualizer` the container ref, and has its item ref place each item it measures, which
   * moves nothing else when the measured size equals the one laid out.
   */
  public bind(
    virtualizer: Virtualizer<TScrollElement, TItemElement>,
  ): DirectlyPlacedVirtualizer<TScrollElement, TItemElement> {
    const measureElement = virtualizer.measureElement;
    virtualizer.measureElement = (element) => {
      measureElement(element);
      if (element !== null && this.#container !== null) {
        const item = virtualizer.measurementsCache[virtualizer.indexFromElement(element)];
        if (item !== undefined) {
          this.#placeItem(virtualizer, item, element);
        }
      }
    };
    return Object.assign(virtualizer, {
      containerRef: (element: HTMLElement | null) => {
        this.#container = element;
        this.#totalSizePx = undefined;
        if (element !== null) {
          this.placeAll(virtualizer);
        }
      },
    });
  }

  /**
   * Holds the indexes a commit drew and whether the virtualizer was scrolling, read as it commits,
   * where nothing has moved them since its render.
   */
  public noteDrawn(virtualizer: Virtualizer<TScrollElement, TItemElement>): void {
    this.#drawn = {
      indexes: virtualizer.getVirtualIndexes(),
      isScrolling: virtualizer.isScrolling,
    };
  }

  /** Whether the virtualizer now draws other items than the last commit, or scrolls otherwise. */
  public drawsAnew(virtualizer: Virtualizer<TScrollElement, TItemElement>): boolean {
    const drawn = this.#drawn;
    const indexes = virtualizer.getVirtualIndexes();
    const isChanged =
      drawn === undefined ||
      drawn.isScrolling !== virtualizer.isScrolling ||
      !hasSameIndexes(drawn.indexes, indexes);
    if (isChanged) {
      this.#drawn = { indexes, isScrolling: virtualizer.isScrolling };
    }
    return isChanged;
  }

  /** Writes the total height and every drawn item's offset that moved. */
  public placeAll(virtualizer: Virtualizer<TScrollElement, TItemElement>): void {
    if (this.#container === null) {
      return;
    }
    this.placeTotalSize(virtualizer);
    for (const item of virtualizer.getVirtualItems()) {
      const element = virtualizer.elementsCache.get(item.key);
      if (element !== undefined) {
        this.#placeItem(virtualizer, item, element);
      }
    }
  }

  /** Writes the total height onto the container when it moved. */
  public placeTotalSize(virtualizer: Virtualizer<TScrollElement, TItemElement>): void {
    const container = this.#container;
    if (container === null) {
      return;
    }
    const totalSizePx = virtualizer.getTotalSize();
    if (totalSizePx !== this.#totalSizePx) {
      this.#totalSizePx = totalSizePx;
      container.style.height = `${String(totalSizePx)}px`;
    }
  }

  #placeItem(
    virtualizer: Virtualizer<TScrollElement, TItemElement>,
    item: VirtualItem,
    element: TItemElement,
  ): void {
    const offsetPx = item.start - virtualizer.options.scrollMargin;
    if (this.#offsetsPx.get(element) === offsetPx) {
      return;
    }
    this.#offsetsPx.set(element, offsetPx);
    element.style.transform = `translate3d(0, ${String(offsetPx)}px, 0)`;
  }
}

function hasSameIndexes(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((index, position) => index === right[position]);
}

function countRedraws(count: number): number {
  return count + 1;
}
