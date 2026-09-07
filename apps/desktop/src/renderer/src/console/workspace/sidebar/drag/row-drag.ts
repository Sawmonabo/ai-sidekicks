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
// THE SETTLE IS A FUNCTION, NOT A CALLBACK BODY. The element adapter cannot be driven
// at all in the `console-unit` tier — jsdom implements neither `DragEvent` nor
// `DataTransfer` — so the outcome lives in `commitSidebarRowDrop`, which a test drives
// directly. An announcement no test can reach goes silently stale.

import { useEffect, useState } from "react";

import {
  draggable,
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
 * Settle one row drop: open what the row names, and say what happened.
 *
 * A drag released over nothing this console recognises reaches here with no target and
 * opens nothing — and says nothing either, because there is no row to name and a
 * sentence about a drag a person abandoned is noise. A drag that DID carry a row is
 * announced in the polite lane: the deck changed, which is the ordinary outcome.
 */
export function commitSidebarRowDrop(
  target: SidebarRowDragTarget | undefined,
  openPane: ConsolePaneOpener,
  announce: Announce,
): void {
  if (target === undefined) {
    return;
  }
  openPane(target.opens);
  announce(`Opened ${target.label} in the deck.`, "polite");
}

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
 * ONE monitor rather than a drop target per pane: the sidebar does not own the deck's
 * elements and must not bind to them, and what a sidebar drop needs from the deck is
 * nothing — the address alone decides what opens. The monitor also runs for a drag
 * released over empty space, which is the case a per-target handler never sees.
 */
export function useSidebarRowDropMonitor(openPane: ConsolePaneOpener, announce: Announce): void {
  useEffect(
    () =>
      monitorForElements({
        canMonitor: ({ source }) => sidebarRowTargetFromDragData(source.data) !== undefined,
        onDrop: ({ source }) => {
          commitSidebarRowDrop(sidebarRowTargetFromDragData(source.data), openPane, announce);
        },
      }),
    [announce, openPane],
  );
}
