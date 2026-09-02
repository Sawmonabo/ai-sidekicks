// The deck's live layout: which panes exist, in what order, at what widths.
//
// `Spec-023 §Console Design (Meridian)` §4.2 gives this module two of the deck's
// five rules; the other three are the persisted grammar's and live in
// `deck-snapshot.ts`.
//
//   • **One entity, one pane.** A second open of the same entity FOCUSES the pane
//     that already shows it. The rule is structural here and structural again at
//     the mount door (`workspace/seats/pane-registry.ts`), which is why neither
//     side needs to trust the other.
//   • **Ephemeral panes cascade.** A `browser` pane opens right of its source and
//     closes with it — so a page nobody asked for cannot outlive the pane that
//     opened it.
//
// STATE LIVES IN THE CLASS, NOT IN REACT. Every mutation goes through a method,
// every method publishes one new immutable `DeckLayoutState`, and React subscribes
// through `useSyncExternalStore`. A component that held pane order in `useState`
// would be a second source of truth for it, and the restore path would have two
// places to write.
//
// This file holds the store and nothing else: the value shapes and the width
// arithmetic are `deck-model.ts`, the snapshot grammar is `deck-snapshot.ts`, and
// both are pure. What is left here is the one thing that genuinely needs identity —
// the mutable deck a session's panes live in.

import { useCallback, useState, useSyncExternalStore } from "react";

import { Emitter, type Unsubscribe } from "../../core/index.js";
import { DEFAULT_DECK_DENSITY, type DeckDensity } from "./density.js";
import {
  DECK_TOTAL_PERMILLE,
  EPHEMERAL_PANE_KINDS,
  addressesMatch,
  distributeEvenly,
  highestOrdinal,
  reorder,
  type DeckLayoutState,
  type DeckPane,
  type DeckPaneAddress,
} from "./deck-model.js";
import {
  decodeDeckSnapshot,
  encodeDeckSnapshot,
  type DeckRestoreReport,
  type DeckSnapshotRecord,
} from "./deck-snapshot.js";

/** Construction inputs. */
export interface DeckLayoutOptions {
  readonly density?: DeckDensity;
  /** Panes a restore may mount. Beyond it the extras are dropped and reported. */
  readonly restoredPaneCap: number;
}

export class DeckLayout {
  readonly #changes = new Emitter<DeckLayoutState>("deck layout change");
  readonly #restoredPaneCap: number;
  #state: DeckLayoutState;
  #nextPaneOrdinal = 1;

  public constructor(options: DeckLayoutOptions) {
    this.#restoredPaneCap = options.restoredPaneCap;
    this.#state = {
      panes: [],
      focusedPaneId: undefined,
      density: options.density ?? DEFAULT_DECK_DENSITY,
      revision: 0,
    };
  }

  /** The current state. Always the state the last notification carried. */
  public snapshot(): DeckLayoutState {
    return this.#state;
  }

  /** Subscribe to transitions. The `useSyncExternalStore` half. */
  public subscribe(listener: (state: DeckLayoutState) => void): Unsubscribe {
    return this.#changes.subscribe(listener);
  }

  /**
   * Open a pane, or focus the one already showing that entity.
   *
   * Returns the pane id either way, so a caller never has to ask which happened to
   * find the pane it asked for.
   */
  public open(address: DeckPaneAddress): string {
    const existing = this.#state.panes.find((pane) => addressesMatch(pane, address));
    if (existing !== undefined) {
      this.focus(existing.paneId);
      return existing.paneId;
    }

    const paneId = `pane-${String(this.#nextPaneOrdinal)}`;
    this.#nextPaneOrdinal += 1;
    const pane: DeckPane = {
      paneId,
      kind: address.kind,
      entity: address.entity,
      sizePermille: DECK_TOTAL_PERMILLE,
      isEphemeral: EPHEMERAL_PANE_KINDS.includes(address.kind),
      sourcePaneId: address.sourcePaneId,
    };

    // Right of its source, when it names one — the `browser` pane's placement rule.
    // At the end otherwise, which is where a person's eye expects a pane they just
    // opened from the sidebar.
    const sourcePosition =
      address.sourcePaneId === undefined
        ? -1
        : this.#state.panes.findIndex((candidate) => candidate.paneId === address.sourcePaneId);
    const panes = [...this.#state.panes];
    panes.splice(sourcePosition < 0 ? panes.length : sourcePosition + 1, 0, pane);

    this.#commit({ panes: distributeEvenly(panes), focusedPaneId: paneId });
    return paneId;
  }

  /**
   * Close a pane and every ephemeral pane that opened beside it.
   *
   * The cascade is one level deep by construction: an ephemeral pane is never a
   * source, because nothing opens beside a `browser` pane. Written as a filter over
   * `sourcePaneId` rather than as a recursive walk, so it cannot loop on a snapshot
   * whose `sourcePaneId` cycles.
   */
  public close(paneId: string): void {
    const survivors = this.#state.panes.filter(
      (pane) => pane.paneId !== paneId && !(pane.isEphemeral && pane.sourcePaneId === paneId),
    );
    if (survivors.length === this.#state.panes.length) {
      return;
    }
    const focusedPaneId = survivors.some((pane) => pane.paneId === this.#state.focusedPaneId)
      ? this.#state.focusedPaneId
      : survivors[survivors.length - 1]?.paneId;
    this.#commit({ panes: distributeEvenly(survivors), focusedPaneId });
  }

  /** Focus a pane. A pane id the deck does not hold changes nothing. */
  public focus(paneId: string): void {
    if (
      this.#state.focusedPaneId === paneId ||
      !this.#state.panes.some((pane) => pane.paneId === paneId)
    ) {
      return;
    }
    this.#commit({ focusedPaneId: paneId });
  }

  /**
   * Focus the next or previous pane, wrapping.
   *
   * Wrapping rather than stopping at the ends: the chord is "cycle the deck", and a
   * two-pane deck where the forward chord stops working is a deck the person has to
   * remember the position of.
   */
  public focusAdjacent(step: 1 | -1): void {
    const { panes, focusedPaneId } = this.#state;
    if (panes.length === 0) {
      return;
    }
    const current = panes.findIndex((pane) => pane.paneId === focusedPaneId);
    const next =
      (((current < 0 ? 0 : current + step) % panes.length) + panes.length) % panes.length;
    const target = panes[next];
    if (target !== undefined) {
      this.focus(target.paneId);
    }
  }

  /** Move a pane one position left or right. The keyboard half of drag-reorder. */
  public movePane(paneId: string, step: 1 | -1): void {
    const from = this.#state.panes.findIndex((pane) => pane.paneId === paneId);
    const to = from + step;
    if (from < 0 || to < 0 || to >= this.#state.panes.length) {
      return;
    }
    this.#commit({ panes: reorder(this.#state.panes, from, to) });
  }

  /** Drop a pane at an absolute position. The drag half; clamped, never refused. */
  public reorderPane(paneId: string, toPosition: number): void {
    const from = this.#state.panes.findIndex((pane) => pane.paneId === paneId);
    if (from < 0) {
      return;
    }
    const to = Math.min(Math.max(toPosition, 0), this.#state.panes.length - 1);
    if (to === from) {
      return;
    }
    this.#commit({ panes: reorder(this.#state.panes, from, to) });
  }

  /**
   * Take `deltaPermille` from the pane after `paneId` and give it to `paneId`.
   *
   * Pairwise rather than global: a separator is between exactly two panes, and
   * spreading the delta across the whole row would move panes the person is not
   * touching. `minimumPermille` is the floor both panes are held above — the deck
   * computes it from the density preset and the measured width, because a floor in
   * permille depends on how wide the deck actually is.
   */
  public resize(paneId: string, deltaPermille: number, minimumPermille: number): void {
    const position = this.#state.panes.findIndex((pane) => pane.paneId === paneId);
    const left = this.#state.panes[position];
    const right = this.#state.panes[position + 1];
    if (left === undefined || right === undefined) {
      return;
    }
    const headroom = right.sizePermille - minimumPermille;
    const legroom = left.sizePermille - minimumPermille;
    const applied = Math.min(Math.max(deltaPermille, -legroom), headroom);
    if (applied === 0) {
      return;
    }
    const panes = this.#state.panes.map((pane) => {
      if (pane.paneId === left.paneId) {
        return { ...pane, sizePermille: pane.sizePermille + applied };
      }
      if (pane.paneId === right.paneId) {
        return { ...pane, sizePermille: pane.sizePermille - applied };
      }
      return pane;
    });
    this.#commit({ panes });
  }

  public setDensity(density: DeckDensity): void {
    if (this.#state.density === density) {
      return;
    }
    this.#commit({ density });
  }

  /** The record the persistence chokepoint stores under the `layout` value class. */
  public toSnapshot(): DeckSnapshotRecord {
    return encodeDeckSnapshot(this.#state);
  }

  /**
   * Adopt a snapshot, dropping what this build cannot interpret.
   *
   * Replaces the deck wholesale rather than merging: a restore happens once, at
   * mount, against an empty deck, and a merge would need a rule for a pane that
   * exists in both — a rule nothing would ever exercise and everything would have
   * to carry.
   */
  public restore(snapshot: unknown): DeckRestoreReport {
    const decoded = decodeDeckSnapshot(snapshot, this.#restoredPaneCap);
    this.#nextPaneOrdinal = highestOrdinal(decoded.panes) + 1;
    this.#commit({
      panes: decoded.panes,
      focusedPaneId: decoded.focusedPaneId,
      density: decoded.density,
    });
    return { restoredPaneCount: decoded.panes.length, refusals: decoded.refusals };
  }

  #commit(change: Partial<DeckLayoutState>): void {
    this.#state = { ...this.#state, ...change, revision: this.#state.revision + 1 };
    this.#changes.emit(this.#state);
  }
}

/**
 * Hold one layout for the lifetime of the component that owns the deck.
 *
 * A hook rather than a construction in a render body: `Spec-023 §Console Design
 * (Meridian)` keeps store construction out of render, and a `new DeckLayout()`
 * evaluated during a render React discards would leave the deck subscribed to a
 * layout nothing will ever mutate again.
 */
export function useDeckLayout(options: DeckLayoutOptions): DeckLayout {
  const [layout] = useState(() => new DeckLayout(options));
  return layout;
}

/** Subscribe to a layout. The one read path; no component reaches `snapshot()`. */
export function useDeckLayoutState(layout: DeckLayout): DeckLayoutState {
  const subscribe = useCallback(
    (onStoreChange: () => void) => layout.subscribe(onStoreChange),
    [layout],
  );
  const read = useCallback(() => layout.snapshot(), [layout]);
  return useSyncExternalStore(subscribe, read, read);
}
