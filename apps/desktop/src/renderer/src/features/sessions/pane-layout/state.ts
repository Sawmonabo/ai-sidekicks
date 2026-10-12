// The pane block's shapes and the pure reading of them. Stateless and free of React. Imports run
// one way: `store` → `snapshot` → `state`.

import type { EntityRef } from "#renderer/lib/entity-kinds.js";
import type { BlockPaneKind } from "#renderer/routing/panes/kinds.js";

/** The sides of the conversation the pane block can stand on. */
export const PANE_BLOCK_SIDES = ["right", "left"] as const;

/** Which side of the conversation the pane block stands on. */
export type PaneBlockSide = (typeof PANE_BLOCK_SIDES)[number];

/** The places the terminal can sit against the row of main panes. */
export const TERMINAL_PLACES = ["below", "above"] as const;

/** Where the terminal sits against the row of main panes. */
export type TerminalPlace = (typeof TERMINAL_PLACES)[number];

/** The side a session's block opens on until a person moves it. */
export const DEFAULT_PANE_BLOCK_SIDE: PaneBlockSide = "right";

/** Where the terminal opens until a person moves it. */
export const DEFAULT_TERMINAL_PLACE: TerminalPlace = "below";

/** One pane in the block. Immutable; every mutation produces a new one. */
export interface SessionPane {
  /** Stable across a layout restore; the identity `PaneContext` carries. */
  readonly paneId: string;
  /** One pane per kind, so the kind also names the pane. */
  readonly kind: BlockPaneKind;
  /** The entity this pane is a view of, or `undefined` for a session-scoped pane. */
  readonly entity: EntityRef | undefined;
  /** The pane this one was opened from, which the inspector names as its link. */
  readonly sourcePaneId: string | undefined;
  /** The pane focused when this one opened, which takes focus back when this one closes. */
  readonly returnFocusPaneId: string | undefined;
}

/** The pane opened or brought forward last, and a count that rises on every open. */
export interface OpenedPane {
  readonly paneId: string;
  readonly serial: number;
}

/** What React renders from. A fresh object per mutation, so `Object.is` decides. */
export interface PaneLayoutState {
  /** The row's main panes in the person's order, and the terminal, wherever it is listed. */
  readonly panes: readonly SessionPane[];
  readonly focusedPaneId: string | undefined;
  readonly side: PaneBlockSide;
  readonly terminalPlace: TerminalPlace;
  /** The pane holding the whole width, or `undefined` while the row is drawn. */
  readonly fullWidthPaneId: string | undefined;
  /** The last open, so the view scrolls that pane into view once per open. */
  readonly lastOpened: OpenedPane | undefined;
  /** Monotonic, so a test can count transitions rather than infer them. */
  readonly revision: number;
}

/** The row's main panes, in order: every pane but the terminal. */
export function rowPanes(panes: readonly SessionPane[]): readonly SessionPane[] {
  return panes.filter((pane) => pane.kind !== "terminal");
}

/** The open terminal, or `undefined` when none is open. */
export function terminalPane(panes: readonly SessionPane[]): SessionPane | undefined {
  return panes.find((pane) => pane.kind === "terminal");
}

/**
 * The pane `step` places from the focused one, the row first and the terminal after it, wrapping;
 * the first pane when none is focused, and `undefined` with no pane open.
 */
export function adjacentPane(
  panes: readonly SessionPane[],
  focusedPaneId: string | undefined,
  step: 1 | -1,
): SessionPane | undefined {
  if (panes.length === 0) {
    return undefined;
  }
  const current = panes.findIndex((pane) => pane.paneId === focusedPaneId);
  const next = (((current < 0 ? 0 : current + step) % panes.length) + panes.length) % panes.length;
  return panes[next];
}

/**
 * The highest `pane-<n>` ordinal among restored panes, so a pane opened after a restore is
 * never minted an id a restored pane already holds.
 */
export function highestOrdinal(panes: readonly SessionPane[]): number {
  let highest = 0;
  for (const pane of panes) {
    const ordinal = Number.parseInt(pane.paneId.replace(/^pane-/, ""), 10);
    if (Number.isFinite(ordinal) && ordinal > highest) {
      highest = ordinal;
    }
  }
  return highest;
}
