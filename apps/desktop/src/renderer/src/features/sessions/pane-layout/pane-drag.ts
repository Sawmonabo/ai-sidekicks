// Dragging a pane to a new position, and the indicator that says where it will land.
//
// `@atlaskit/pragmatic-drag-and-drop` owns the gesture (the browser's own HTML5 drag, so no
// React render per frame); this module owns where a drop may land and what is shown and said.
// It does not decide the new order: a drop commits through `PaneLayoutStore.reorderPane`. It
// offers no keyboard drag, which the library does not provide; Alt+Shift+Arrow moves the
// focused pane instead.
//
// The indicator lives in a class, not `useState`, because the library sets it from callbacks
// outside React, which is what `useSyncExternalStore` is for.

import type { Unsubscribe } from "@shared/preload-api.js";
import { Emitter } from "@renderer/lib/emitter.js";
import {
  type Announce,
  type AnnouncementPoliteness,
} from "@renderer/components/LiveAnnouncer/live-announcer.js";
import { TITLE_BY_PANE_KIND } from "@renderer/components/PaneFrame/PaneFrame.js";
import { type PaneKind } from "@renderer/routing/panes/pane-kinds.js";
import type { PaneLayoutStore } from "./pane-layout-store.js";

/**
 * The key a pane drag's payload is carried under. Namespaced because the monitor sees every
 * element drag on the page, and must decline a payload it does not recognize.
 */
export const PANE_LAYOUT_DRAG_KEY = "paneLayout.paneId";

/** Which side of a pane a drop would land on. */
export const PANE_DROP_EDGES = ["before", "after"] as const;

/** One drop edge. */
export type PaneDropEdge = (typeof PANE_DROP_EDGES)[number];

/** Where the drop indicator currently sits, or nothing while nothing is in the air. */
export interface PaneDropIndicator {
  readonly overPaneId: string;
  readonly edge: PaneDropEdge;
}

/** What a settled drop is announced as, and in which lane. */
export interface PaneDropAnnouncement {
  readonly message: string;
  readonly politeness: AnnouncementPoliteness;
}

/**
 * The pane layout's live drag state: what is in the air, and where it would land.
 *
 * One instance per pane layout. It publishes only on a real change, so a pointer crossing a
 * pane without crossing its midpoint costs no render.
 */
export class PaneLayoutDragCoordinator {
  readonly #changes = new Emitter<PaneDropIndicator | undefined>("pane drag change");
  #indicator: PaneDropIndicator | undefined;
  #draggedPaneId: string | undefined;

  /** The indicator to draw, or `undefined` when nothing is being dragged. */
  public snapshot(): PaneDropIndicator | undefined {
    return this.#indicator;
  }

  /** The pane currently in the air, so its own frame can show it has left. */
  public get draggedPaneId(): string | undefined {
    return this.#draggedPaneId;
  }

  /** Listens for indicator changes; `undefined` means nothing is in the air. */
  public subscribe(listener: (indicator: PaneDropIndicator | undefined) => void): Unsubscribe {
    return this.#changes.subscribe(listener);
  }

  /** Records the pane that has been picked up. */
  public startDrag(paneId: string): void {
    this.#draggedPaneId = paneId;
  }

  /** Moves the indicator. A move onto the position it already holds publishes nothing. */
  public hover(indicator: PaneDropIndicator): void {
    if (
      this.#indicator?.overPaneId === indicator.overPaneId &&
      this.#indicator.edge === indicator.edge
    ) {
      return;
    }
    this.#indicator = indicator;
    this.#changes.emit(this.#indicator);
  }

  /** Clears the indicator, for a drag that left every target or ended. */
  public clear(): void {
    this.#draggedPaneId = undefined;
    if (this.#indicator === undefined) {
      return;
    }
    this.#indicator = undefined;
    this.#changes.emit(undefined);
  }
}

/** Reads a pane id off a drag payload, or `undefined` for a drag that is not ours. */
export function paneIdFromDragData(data: Record<string, unknown>): string | undefined {
  const paneId = data[PANE_LAYOUT_DRAG_KEY];
  return typeof paneId === "string" ? paneId : undefined;
}

/**
 * Which edge of `element` the pointer at `clientX` is nearer. One comparison, so the library's
 * hitbox package is not added for it.
 */
export function dropEdgeFor(element: Element, clientX: number): PaneDropEdge {
  const rect = element.getBoundingClientRect();
  return clientX < rect.left + rect.width / 2 ? "before" : "after";
}

/**
 * Where a pane dragged onto `overPaneId`'s `edge` lands, in the order after removal, or
 * `undefined` when either pane is unknown or they are the same.
 *
 * The dragged pane is taken out before it is put back, so a target to its right has shifted
 * left by one.
 */
export function dropPosition(
  paneIds: readonly string[],
  draggedPaneId: string,
  overPaneId: string,
  edge: PaneDropEdge,
): number | undefined {
  const from = paneIds.indexOf(draggedPaneId);
  const over = paneIds.indexOf(overPaneId);
  if (from < 0 || over < 0 || from === over) {
    return undefined;
  }
  const insertion = edge === "before" ? over : over + 1;
  return insertion > from ? insertion - 1 : insertion;
}

/**
 * What a settled drop is announced as. The library reports only that a drag ended.
 *
 * A move is polite; a drop that changed nothing is assertive, because that lane is for "the
 * thing you tried did not happen". The position is one-based and given against the pane count.
 */
export function paneDropAnnouncement(
  paneKind: PaneKind,
  fromPosition: number,
  toPosition: number,
  paneCount: number,
): PaneDropAnnouncement {
  if (fromPosition === toPosition) {
    return {
      message: `The ${TITLE_BY_PANE_KIND[paneKind]} pane was not moved.`,
      politeness: "assertive",
    };
  }
  return {
    message:
      `Moved the ${TITLE_BY_PANE_KIND[paneKind]} pane to position ` +
      `${String(toPosition + 1)} of ${String(paneCount)}.`,
    politeness: "polite",
  };
}

/**
 * Settles one drop: commits the reorder the indicator names and announces what happened.
 *
 * A function so tests can reach it, since jsdom implements neither `DragEvent` nor
 * `DataTransfer`. Whether the pane moved is measured from its index before and after:
 * `dropPosition` can name the position the pane already holds, and `reorderPane` then no-ops.
 */
export function commitPaneDrop(
  layout: PaneLayoutStore,
  draggedPaneId: string | undefined,
  indicator: PaneDropIndicator | undefined,
  announce: Announce,
): void {
  if (draggedPaneId === undefined) {
    return;
  }
  const before = layout.snapshot().panes;
  const fromPosition = before.findIndex((pane) => pane.paneId === draggedPaneId);
  const draggedPane = before[fromPosition];
  if (draggedPane === undefined) {
    // The pane left the layout while in the air: nothing to move or name, so say nothing.
    return;
  }
  if (indicator !== undefined) {
    const position = dropPosition(
      before.map((pane) => pane.paneId),
      draggedPaneId,
      indicator.overPaneId,
      indicator.edge,
    );
    if (position !== undefined) {
      layout.reorderPane(draggedPaneId, position);
    }
  }
  const after = layout.snapshot().panes;
  const toPosition = after.findIndex((pane) => pane.paneId === draggedPaneId);
  const announcement = paneDropAnnouncement(
    draggedPane.kind,
    fromPosition,
    toPosition,
    after.length,
  );
  announce(announcement.message, announcement.politeness);
}
