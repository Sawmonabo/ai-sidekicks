// What a deck is made of: the pane shape, the state shape, and the arithmetic that
// keeps a row of panes summing to a whole deck.
//
// Split out of `deck-layout.ts` because that file was doing three jobs — these
// shapes, the persisted grammar, and the live store — and the three have different
// readers. This one is the vocabulary layer of the deck: it holds no state, touches
// no React, and every function in it is pure, so the width arithmetic can be
// checked without constructing a layout at all.
//
// The dependency runs one way and only one way: `deck-model` → `deck-snapshot` →
// `deck-layout`. Nothing here imports either of the other two.

import type { ConsoleEntityRef } from "../../store/index.js";
import type { PaneKind } from "../seats/index.js";
import type { DeckDensity } from "./density.js";

/**
 * Pane widths are carried as permille of the deck, summing to this.
 *
 * Integers rather than fractions because the value is persisted, and a float that
 * round-trips through JSON reintroduces the accumulation error the normalisation
 * step exists to remove. Permille rather than percent so a five-pane deck divides
 * evenly.
 */
export const DECK_TOTAL_PERMILLE = 1000;

/**
 * The pane kinds that are never written to a snapshot.
 *
 * `Spec-023 §Console Design (Meridian)` §4.2: a `browser` pane "is ephemeral: it is
 * never written to the layout snapshot". Declared as a set rather than tested with
 * `kind === "browser"` at three sites, so a second ephemeral kind is one edit.
 */
export const EPHEMERAL_PANE_KINDS: readonly PaneKind[] = ["browser"];

/** One pane in the deck. Immutable; every mutation produces a new one. */
export interface DeckPane {
  /** Stable across a layout restore — the identity `ConsolePaneContext` carries. */
  readonly paneId: string;
  readonly kind: PaneKind;
  /** The entity this pane is a view of, or `undefined` for a session-scoped pane. */
  readonly entity: ConsoleEntityRef | undefined;
  /** This pane's share of the deck, in permille. */
  readonly sizePermille: number;
  /** True for a pane that is never persisted and cascades closed with its source. */
  readonly isEphemeral: boolean;
  /** The pane this one opened beside, when it opened beside one. */
  readonly sourcePaneId: string | undefined;
}

/** What React renders from. A fresh object per mutation, so `Object.is` decides. */
export interface DeckLayoutState {
  readonly panes: readonly DeckPane[];
  readonly focusedPaneId: string | undefined;
  readonly density: DeckDensity;
  /** Monotonic, so a test can count transitions rather than infer them. */
  readonly revision: number;
}

/** Which pane, over which entity — the address `open` resolves. */
export interface DeckPaneAddress {
  readonly kind: PaneKind;
  readonly entity: ConsoleEntityRef | undefined;
  /** Open beside this pane rather than at the end. The `browser` pane's rule. */
  readonly sourcePaneId?: string;
}

/**
 * Whether an open pane is already the pane an address asks for.
 *
 * Kind PLUS entity, because the same run legitimately appears in a `runs` pane and
 * an `inspector`, and collapsing them onto one pane would make the second open
 * silently steal the first.
 */
export function addressesMatch(pane: DeckPane, address: DeckPaneAddress): boolean {
  return (
    pane.kind === address.kind &&
    pane.entity?.kind === address.entity?.kind &&
    pane.entity?.id === address.entity?.id
  );
}

/** Move one pane from `from` to `to`. Returns the input unchanged on a bad index. */
export function reorder(panes: readonly DeckPane[], from: number, to: number): readonly DeckPane[] {
  const next = [...panes];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) {
    return panes;
  }
  next.splice(to, 0, moved);
  return next;
}

/** Give every pane an equal share. What opening and closing leave behind. */
export function distributeEvenly(panes: readonly DeckPane[]): readonly DeckPane[] {
  if (panes.length === 0) {
    return panes;
  }
  const share = Math.floor(DECK_TOTAL_PERMILLE / panes.length);
  return panes.map((pane, position) => ({
    ...pane,
    // The remainder goes to the first pane rather than being spread, so the sum is
    // exact and the arithmetic is one line a reader can check.
    sizePermille: position === 0 ? DECK_TOTAL_PERMILLE - share * (panes.length - 1) : share,
  }));
}

/** Rescale restored sizes so they sum to the total, whatever was on disk. */
export function normalise(panes: readonly DeckPane[]): readonly DeckPane[] {
  const total = panes.reduce((sum, pane) => sum + pane.sizePermille, 0);
  if (panes.length === 0 || total <= 0) {
    return distributeEvenly(panes);
  }
  return panes.map((pane) => ({
    ...pane,
    sizePermille: Math.max(1, Math.round((pane.sizePermille / total) * DECK_TOTAL_PERMILLE)),
  }));
}

/**
 * The highest `pane-<n>` ordinal among restored panes.
 *
 * Read rather than reset, so a pane opened after a restore cannot be minted with an
 * id a restored pane already holds — which would make `close` remove two panes and
 * `focus` land on whichever the array reached first.
 */
export function highestOrdinal(panes: readonly DeckPane[]): number {
  let highest = 0;
  for (const pane of panes) {
    const ordinal = Number.parseInt(pane.paneId.replace(/^pane-/, ""), 10);
    if (Number.isFinite(ordinal) && ordinal > highest) {
      highest = ordinal;
    }
  }
  return highest;
}
