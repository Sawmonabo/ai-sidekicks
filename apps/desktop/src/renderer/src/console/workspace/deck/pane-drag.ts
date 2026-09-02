// Dragging a pane to a new position, and the indicator that says where it will land.
//
// `Spec-023 §Console Libraries`, row "Layout, panes, drag": ADOPT
// `@atlaskit/pragmatic-drag-and-drop` 3.1.0 for drag, OWN-BUILD the drop indicators,
// the keyboard and menu reorder paths, and the live-region strings. So this module
// is the seam between the two — the library owns the gesture and this file owns
// where it may land and what the person sees while it is in the air.
//
// THREE THINGS THIS DELIBERATELY DOES NOT DO:
//
//   • **It does not decide the new order.** Every drop calls
//     `DeckLayout.reorderPane`, which is the same method the Alt+Shift chord and
//     the pane menu already commit through. A drag that computed its own order
//     would be a second implementation of the deck's one reorder rule.
//   • **It does not render a preview.** The library's drag is the browser's own
//     HTML5 drag, so the browser draws the dragged element and no React render
//     happens per frame — which is the reason the row picks this library over the
//     pointer-event families it names under AVOID.
//   • **It does not offer a keyboard drag.** The library provides none by design
//     (its accessibility guidance says so in terms), and the deck already has the
//     accessible equivalent: Alt+Shift+Arrow moves the focused pane. The gesture is
//     an addition to that path, never a replacement for it.
//
// STATE LIVES IN A CLASS. The indicator is one value — which pane, which edge —
// that changes many times during a drag and is read by one component. Held in
// `useState` inside the deck it would be set from a library callback outside
// React's knowledge, which is exactly the shape `useSyncExternalStore` exists for.

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from "@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter";

import { Emitter, type Unsubscribe } from "../../core/index.js";
import { type Announce, type AnnouncementPoliteness } from "../../primitives/index.js";
import { type PaneKind } from "../seats/index.js";
import type { DeckLayout } from "./deck-layout.js";

/**
 * The key a pane drag's payload is carried under.
 *
 * Namespaced rather than a bare `paneId`, because the element adapter's monitor
 * sees every element drag on the page: a `deck.paneId` key is what lets the deck's
 * monitor tell a pane header from a ledger row somebody else made draggable, and a
 * payload it does not recognise is one it declines to act on rather than one it
 * misreads.
 */
export const DECK_PANE_DRAG_KEY = "deck.paneId";

/** Which side of a pane a drop would land on. */
export const PANE_DROP_EDGES = ["before", "after"] as const;

/** One drop edge. Derived from the enumeration, never restated. */
export type PaneDropEdge = (typeof PANE_DROP_EDGES)[number];

/** Where the drop indicator currently sits, or nothing while nothing is in the air. */
export interface PaneDropIndicator {
  readonly overPaneId: string;
  readonly edge: PaneDropEdge;
}

/** Read a pane id off a drag payload, or `undefined` for a drag that is not ours. */
export function paneIdFromDragData(data: Record<string, unknown>): string | undefined {
  const paneId = data[DECK_PANE_DRAG_KEY];
  return typeof paneId === "string" ? paneId : undefined;
}

/**
 * Which edge of `element` the pointer at `clientX` is nearer.
 *
 * Own-built rather than the library's hitbox package: the deck needs one axis and
 * two outcomes, the arithmetic is one comparison, and the row admits the core
 * package only — a second package for a midpoint test would be a dependency added
 * ahead of a need.
 */
export function dropEdgeFor(element: Element, clientX: number): PaneDropEdge {
  const rect = element.getBoundingClientRect();
  return clientX < rect.left + rect.width / 2 ? "before" : "after";
}

/**
 * Where a pane dragged onto `overPaneId`'s `edge` lands, in the order after removal.
 *
 * Stated as a function so the two callers that need it — the drop handler and its
 * test — cannot disagree, and so the off-by-one that a "drop after, moving right"
 * always has is written down once. The dragged pane is taken out of the row before
 * it is put back, so a target that sat to its right has already shifted left by one.
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

/** What a settled drop is said out loud as, and in which of the two lanes. */
export interface PaneDropAnnouncement {
  readonly message: string;
  readonly politeness: AnnouncementPoliteness;
}

/**
 * What a settled drop is announced as.
 *
 * `Spec-023 §Console Libraries`, row "Layout, panes, drag", keeps the live-region
 * strings own-built, and this is where they are built. The outcome of a drop is
 * invisible to a person who is not watching the deck move, and the LIBRARY says
 * nothing: it reports that a drag ended, not whether the deck changed.
 *
 * A move is POLITE and a drop that changed nothing is ASSERTIVE. That looks
 * backwards until the lanes are read as `live-announcer.ts` defines them — the
 * assertive lane is for "the thing you tried did not happen", which is exactly a
 * drop released over empty space or back onto the position it started from. A move
 * that landed is the ordinary outcome and waits its turn.
 *
 * The position is stated one-based and against the deck's own count, because
 * "position 2" alone is a number a person has to hold the deck's size in their head
 * to use.
 */
export function paneDropAnnouncement(
  paneKind: PaneKind,
  fromPosition: number,
  toPosition: number,
  paneCount: number,
): PaneDropAnnouncement {
  if (fromPosition === toPosition) {
    return { message: `The ${paneKind} pane was not moved.`, politeness: "assertive" };
  }
  return {
    message: `Moved the ${paneKind} pane to position ${String(toPosition + 1)} of ${String(paneCount)}.`,
    politeness: "polite",
  };
}

/**
 * Settle one drop: commit the reorder the indicator names, and say what happened.
 *
 * A function rather than a body inside the monitor's callback, because this is the
 * only place the outcome exists and the library's callback cannot be driven at all
 * in the `console-unit` tier — jsdom implements neither `DragEvent` nor
 * `DataTransfer`. An announcement no test can reach is an announcement that goes
 * silently stale, which is the same class of defect as not raising one.
 *
 * `announce` is a PARAMETER and not a `useAnnounce()` call here. The hook context is
 * read once, by the deck component that mounts this monitor; a second read inside
 * the drag seam would make every host of this module a host of the announcer too.
 *
 * WHETHER THE PANE MOVED IS MEASURED, NOT ASSUMED. `dropPosition` can answer with a
 * position the deck is already in — dropping "before the pane on my right" is the
 * position the dragged pane already holds — and `DeckLayout.reorderPane` clamps and
 * then no-ops. So the announcement reads the pane's index before and after rather
 * than trusting that a defined drop position means a changed deck.
 */
export function commitPaneDrop(
  layout: DeckLayout,
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
    // A drag whose pane left the deck while it was in the air. Nothing to move and
    // nothing to name, so nothing is said — an announcement about a pane that is
    // gone is worse than silence.
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

/**
 * The deck's live drag state: what is in the air, and where it would land.
 *
 * One instance per deck. Every mutation publishes, and publishes only on a real
 * change, so a pointer crossing a pane without crossing its midpoint costs no
 * render at all — the budget the row's "no per-frame renders" constraint states.
 */
export class DeckDragCoordinator {
  readonly #changes = new Emitter<PaneDropIndicator | undefined>("deck drag change");
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

  public subscribe(listener: (indicator: PaneDropIndicator | undefined) => void): Unsubscribe {
    return this.#changes.subscribe(listener);
  }

  public startDrag(paneId: string): void {
    this.#draggedPaneId = paneId;
  }

  /** Move the indicator. A move onto the position it already holds publishes nothing. */
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

  /** Clear the indicator — a drag that left every target, or one that ended. */
  public clear(): void {
    this.#draggedPaneId = undefined;
    if (this.#indicator === undefined) {
      return;
    }
    this.#indicator = undefined;
    this.#changes.emit(undefined);
  }
}

/** Hold one coordinator for the lifetime of the deck that owns it. */
export function useDeckDragCoordinator(): DeckDragCoordinator {
  const [coordinator] = useState(() => new DeckDragCoordinator());
  return coordinator;
}

/** Subscribe to the indicator. The one read path; no component reads `snapshot()`. */
export function useDeckDropIndicator(
  coordinator: DeckDragCoordinator,
): PaneDropIndicator | undefined {
  const subscribe = useCallback(
    (onStoreChange: () => void) => coordinator.subscribe(onStoreChange),
    [coordinator],
  );
  const read = useCallback(() => coordinator.snapshot(), [coordinator]);
  return useSyncExternalStore(subscribe, read, read);
}

/**
 * Make one pane's header the handle that drags its pane.
 *
 * The header and not the whole pane: a pane body holds text a person selects and
 * controls they click, and a draggable ancestor turns every one of those into the
 * start of a drag. The header is the strip that means "this pane", which is what
 * makes it the handle in every deck a person has used.
 */
export function usePaneDragSource(
  coordinator: DeckDragCoordinator,
  paneId: string,
): (element: HTMLElement | null) => void {
  const [handle, setHandle] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (handle === null) {
      return;
    }
    return draggable({
      element: handle,
      getInitialData: () => ({ [DECK_PANE_DRAG_KEY]: paneId }),
      onDragStart: () => {
        coordinator.startDrag(paneId);
      },
    });
  }, [coordinator, handle, paneId]);

  return setHandle;
}

/**
 * Make one pane a place a dragged pane can land.
 *
 * The target is the pane's own root element rather than its header, so the whole
 * column is a target: a person dragging over a pane should not have to find a strip
 * to aim at, and the edge is decided by the pointer's position within the pane, not
 * by which part of it the pointer is over.
 */
export function usePaneDropTarget(
  coordinator: DeckDragCoordinator,
  paneId: string,
  element: HTMLElement | null,
): void {
  useEffect(() => {
    if (element === null) {
      return;
    }
    return dropTargetForElements({
      element,
      canDrop: ({ source }) => {
        const draggedPaneId = paneIdFromDragData(source.data);
        return draggedPaneId !== undefined && draggedPaneId !== paneId;
      },
      getData: () => ({ [DECK_PANE_DRAG_KEY]: paneId }),
      onDrag: ({ location }) => {
        coordinator.hover({
          overPaneId: paneId,
          edge: dropEdgeFor(element, location.current.input.clientX),
        });
      },
      onDragLeave: () => {
        coordinator.clear();
      },
    });
  }, [coordinator, element, paneId]);
}

/**
 * Commit the drop, once, for the whole deck.
 *
 * ONE monitor rather than an `onDrop` per target, because the outcome depends on
 * the indicator the coordinator holds — which target the pointer settled on and
 * which edge — and a per-target handler would each have to re-derive it. The
 * monitor also runs for a drag that ends over nothing, which is the case that has
 * to clear the indicator and commit nothing; a per-target handler never fires there
 * at all. That case is also the one a person gets no feedback from unless it is
 * SAID — the deck looks the same as it did — so it reaches `commitPaneDrop` like
 * every other drop rather than returning early.
 *
 * @param announce The window's announcer, read from the context by the deck.
 */
export function useDeckDragMonitor(
  coordinator: DeckDragCoordinator,
  layout: DeckLayout,
  announce: Announce,
): void {
  useEffect(
    () =>
      monitorForElements({
        canMonitor: ({ source }) => paneIdFromDragData(source.data) !== undefined,
        onDrop: ({ source }) => {
          const draggedPaneId = paneIdFromDragData(source.data);
          const indicator = coordinator.snapshot();
          coordinator.clear();
          commitPaneDrop(layout, draggedPaneId, indicator, announce);
        },
      }),
    [announce, coordinator, layout],
  );
}
