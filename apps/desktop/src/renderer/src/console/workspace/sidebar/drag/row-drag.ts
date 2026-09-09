// Dragging a sidebar row onto the deck, and what opens when it lands.
//
// `Spec-023 §Console Design (Meridian)` §The surface set offers "drag a row to the
// deck → open as a pane at the drop slot", and `Spec-023 §Console Libraries`, row
// "Layout, panes, drag", ADOPTs `@atlaskit/pragmatic-drag-and-drop` for the gesture
// with the indicators, the keyboard paths, and the live-region strings own-built. This
// module is the sidebar's half of that seam, and it is deliberately the same shape as
// `workspace/deck/pane-drag.ts`: the library owns the gesture, this file owns what the
// payload means and what a settled drop does.
//
// IT OPENS THROUGH THE SAME DOOR A CLICK OPENS THROUGH. A drop calls the column's own
// `ConsolePaneOpener` — the one the sidebar was handed, so a sidebar in an auxiliary
// window opens into THAT window's deck — and the deck's own one-entity-one-pane rule
// then decides whether a pane is created or an existing one is focused. A drag that
// computed its own answer would be a second implementation of that rule.
//
// IT ADDS NO KEYBOARD PATH, because the column already has the accessible equivalent:
// `Enter` on the cursored row opens it. The library provides no keyboard drag by
// design, and the gesture is an addition to that path rather than a replacement.
//
// AND IT OPENS ONLY WHERE THE ROW WAS DROPPED ON THE DECK. A monitor hears every drag
// that ends, wherever it ended — over the deck, back over the sidebar, over the window
// chrome, or nowhere at all because the person pressed Escape — and `canMonitor` says
// only that the thing in the air is one of ours. So the settle reads the DROP as well
// as the source: without that, abandoning a gesture opened the row's pane and said so,
// which is a console acting on a decision a person had just reversed.
//
// WHICH MAKES THE DECK A DROP TARGET, and this module declares both halves of that
// seam. The key the deck's target carries and the reader that recognises it are next to
// the key a row's payload is carried under, because they are one contract read from two
// sides — the deck supplies its own element and this file says what lands on it. Two
// modules, and the pair drifts the first time one of them is renamed.
//
// THE SETTLE IS A FUNCTION, NOT A CALLBACK BODY. The element adapter cannot be driven
// at all in the `console-unit` tier — jsdom implements neither `DragEvent` nor
// `DataTransfer` — so the outcome lives in `commitSidebarRowDrop`, which a test drives
// directly. An announcement no test can reach goes silently stale.

import { useEffect, useState } from "react";

import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from "@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter";

import { type Announce } from "../../../primitives/index.js";
import { type ConsolePaneOpener, type SidebarRowDragTarget } from "../../../seats/index.js";

/**
 * The key a sidebar row's payload is carried under.
 *
 * Namespaced for `DECK_PANE_DRAG_KEY`'s reason: the element adapter's monitor sees
 * every element drag on the page, so the key is what lets this monitor tell a sidebar
 * row from a pane header — and a payload it does not recognise is one it declines to
 * act on rather than one it misreads.
 */
export const SIDEBAR_ROW_DRAG_KEY = "sidebar.rowTarget";

/** Read a row target off a drag payload, or `undefined` for a drag that is not ours. */
export function sidebarRowTargetFromDragData(
  data: Record<string, unknown>,
): SidebarRowDragTarget | undefined {
  const target: unknown = data[SIDEBAR_ROW_DRAG_KEY];
  if (typeof target !== "object" || target === null) {
    return undefined;
  }
  const candidate = target as Partial<SidebarRowDragTarget>;
  if (typeof candidate.nodeId !== "string" || typeof candidate.label !== "string") {
    return undefined;
  }
  if (candidate.opens === undefined) {
    return undefined;
  }
  return { nodeId: candidate.nodeId, label: candidate.label, opens: candidate.opens };
}

/**
 * The key the deck's own drop target is carried under.
 *
 * A SECOND KEY AND NOT THE ROW'S. The row's key names what is in the AIR and the
 * deck's names where it may LAND, and the monitor reads both — one off the source, one
 * off the drop targets the pointer settled over. Spelled as one key, a deck target
 * would answer "is this drag mine" and a row payload would answer "is this a place to
 * drop", and the two questions would share an answer.
 */
export const SIDEBAR_ROW_DECK_DROP_KEY = "sidebar.deckDropTarget";

/**
 * Every row's bound drag source, one per row that is on screen.
 *
 * A CLASS holding the binders, because a ref callback rebuilt on every render is a
 * `draggable()` torn down and rebound on every keystroke in the filter field. The
 * binder is cached per row id and the cache is bounded by the rows themselves: the ref
 * callback is called with `null` when the row unmounts, and that is where the entry is
 * dropped. There is no cap to choose, because nothing accumulates.
 */
export class SidebarRowDragSources {
  readonly #bindersByNodeId = new Map<string, (element: HTMLElement | null) => void>();
  readonly #cleanupsByNodeId = new Map<string, () => void>();

  /** The ref callback one row binds its element through. Stable for that row's id. */
  public binderFor(target: SidebarRowDragTarget): (element: HTMLElement | null) => void {
    const bound = this.#bindersByNodeId.get(target.nodeId);
    if (bound !== undefined) {
      return bound;
    }
    const binder = (element: HTMLElement | null): void => {
      this.#cleanupsByNodeId.get(target.nodeId)?.();
      this.#cleanupsByNodeId.delete(target.nodeId);
      if (element === null) {
        this.#bindersByNodeId.delete(target.nodeId);
        return;
      }
      this.#cleanupsByNodeId.set(
        target.nodeId,
        draggable({
          element,
          // Read at drag start rather than captured at bind time: a row keeps its id
          // while its label and its address move under it, and a payload frozen at
          // mount would open the pane the row used to name.
          getInitialData: () => ({ [SIDEBAR_ROW_DRAG_KEY]: target }),
        }),
      );
    };
    this.#bindersByNodeId.set(target.nodeId, binder);
    return binder;
  }

  /** Unbind everything. Called when the column that owns these rows goes away. */
  public dispose(): void {
    for (const cleanup of this.#cleanupsByNodeId.values()) {
      cleanup();
    }
    this.#cleanupsByNodeId.clear();
    this.#bindersByNodeId.clear();
  }
}

/** Whether one of the drop targets a gesture settled over is the deck's. */
export function isSidebarRowDeckDropTarget(data: Record<string | symbol, unknown>): boolean {
  return data[SIDEBAR_ROW_DECK_DROP_KEY] === true;
}

/**
 * Make the deck a place a dragged sidebar row can land.
 *
 * THE DECK'S OWN ROOT AND NOT ITS PANES. What a row opens is decided by the address it
 * carries, so there is no slot to aim at and no edge to compute — the whole board is
 * the target, which is also what makes an EMPTY deck a place to drop, and an empty deck
 * is the one a person is most likely to be dragging onto.
 *
 * `canDrop` narrows it to row drags, so a pane being dragged around inside the deck
 * never sees this target at all: the deck's own per-pane targets decide that gesture,
 * and a root target that accepted everything would sit under every one of them claiming
 * a drop it has no rule for.
 *
 * The element is passed rather than reached for — a `ref` this module owned would be a
 * second holder of an element the deck already has — and `null` before the deck mounts
 * binds nothing, which is the ordinary first pass rather than a case.
 */
export function useSidebarRowDeckDropTarget(element: HTMLElement | null): void {
  useEffect(() => {
    if (element === null) {
      return;
    }
    return dropTargetForElements({
      element,
      canDrop: ({ source }) => sidebarRowTargetFromDragData(source.data) !== undefined,
      getData: () => ({ [SIDEBAR_ROW_DECK_DROP_KEY]: true }),
    });
  }, [element]);
}

/**
 * Settle one row drop: open what the row names, and say what happened.
 *
 * TWO FACTS DECIDE IT, and the second one is the whole reason this takes an argument
 * the monitor has to work out. `target` says the thing in the air was one of ours; a
 * drag released over nothing this console recognises reaches here without one, opens
 * nothing, and says nothing either, because there is no row to name and a sentence
 * about a drag that was never ours is noise. `droppedOnDeck` says where it LANDED —
 * the monitor hears a drop wherever the gesture ended, so a row released back over the
 * sidebar, over the window chrome, or abandoned outright arrives here exactly as one
 * released over the deck does, and only the drop targets tell them apart.
 *
 * A LANDED DROP IS POLITE AND AN ABANDONED ONE IS ASSERTIVE, which is
 * `deck/pane-drag.ts`'s own rule for the same pair of outcomes: the assertive lane is
 * for "the thing you tried did not happen", and a person who cannot see the deck has no
 * other way to learn that a gesture they completed changed nothing. Silence there would
 * be indistinguishable from success.
 */
export function commitSidebarRowDrop(
  target: SidebarRowDragTarget | undefined,
  droppedOnDeck: boolean,
  openPane: ConsolePaneOpener,
  announce: Announce,
): void {
  if (target === undefined) {
    return;
  }
  if (!droppedOnDeck) {
    announce(`${target.label} was not opened.`, "assertive");
    return;
  }
  openPane(target.opens);
  announce(`Opened ${target.label} in the deck.`, "polite");
}

/** Hold one set of row sources for the lifetime of the column that owns them. */
export function useSidebarRowDragSources(): SidebarRowDragSources {
  const [sources] = useState(() => new SidebarRowDragSources());
  useEffect(
    () => () => {
      sources.dispose();
    },
    [sources],
  );
  return sources;
}

/**
 * Commit the drop, once, for the whole column.
 *
 * ONE monitor rather than an `onDrop` on the deck's target: the outcome depends on the
 * source AND on where the gesture ended, and the case that has to be heard — a drag
 * abandoned, or released anywhere but the deck — is precisely the one a target's own
 * handler never fires for. So the monitor hears every ending and asks the drop targets
 * which one it was.
 *
 * The sidebar still binds to none of the deck's elements: `useSidebarRowDeckDropTarget`
 * is called BY the deck, on the deck's own root, and what crosses between them is a
 * key rather than a node.
 */
export function useSidebarRowDropMonitor(openPane: ConsolePaneOpener, announce: Announce): void {
  useEffect(
    () =>
      monitorForElements({
        canMonitor: ({ source }) => sidebarRowTargetFromDragData(source.data) !== undefined,
        onDrop: ({ location, source }) => {
          commitSidebarRowDrop(
            sidebarRowTargetFromDragData(source.data),
            location.current.dropTargets.some((dropTarget) =>
              isSidebarRowDeckDropTarget(dropTarget.data),
            ),
            openPane,
            announce,
          );
        },
      }),
    [announce, openPane],
  );
}
