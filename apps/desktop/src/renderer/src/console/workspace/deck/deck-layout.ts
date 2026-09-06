// The deck's live layout: which panes exist, in what order, at what widths.
//
// This module holds two of the deck's five rules; the other three are the persisted
// grammar's and live in `deck-snapshot.ts`.
//
//   • **One entity, one pane.** `Spec-023 §The surface set` states it: "one entity
//     opens one pane, structurally (a single mount door and a tripwire that fails on
//     a second)". A second open of the same entity FOCUSES the pane that already shows
//     it. The rule is structural here and structural again at the mount door
//     (`seats/pane-registry.ts`), which is why neither side needs to trust
//     the other.
//   • **Ephemeral panes cascade.** This deck's own rule, because no committed document
//     states one: a `browser` pane opens right of its source and closes with it — so a
//     page nobody asked for cannot outlive the pane that opened it.
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
import { DEFAULT_DECK_DENSITY, type DeckDensity } from "../workspace-bounds.js";
import {
  DECK_TOTAL_PERMILLE,
  EPHEMERAL_PANE_KINDS,
  addressesMatch,
  applyPaneSizePercentages,
  distributeAdoptedBeneath,
  distributeEvenly,
  highestOrdinal,
  paneAddressKey,
  reorder,
  sizesAreEqual,
  type DeckLayoutState,
  type DeckPane,
  type DeckPaneAddress,
  type PaneSizePercentages,
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

    const paneId = this.#mintPaneId();
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
   * Adopt the widths the panel group settled on.
   *
   * THE STORE STAYS THE SOURCE OF TRUTH, WHICH IS WHY THIS IS A WRITE-BACK AND NOT
   * A SUBSCRIPTION. `Spec-023 §Console Libraries` admits `react-resizable-panels`
   * under one constraint — "store-owned layout" — so the group reports what a drag
   * or an arrow key settled on and this method decides what the deck keeps: clamped
   * to the deck's own floor, renormalised to the total, and dropped entirely when
   * nothing moved.
   *
   * The no-op guard is load-bearing rather than an optimisation. The group reports
   * its layout after every commit, including the ones this method caused; without
   * the guard each report would raise the revision, the raised revision would
   * re-render the group, and the deck would settle only because the values stopped
   * changing rather than because anything stopped it.
   */
  public applyLayout(percentages: PaneSizePercentages, minimumPermille: number): void {
    if (this.#state.panes.length === 0) {
      return;
    }
    const panes = applyPaneSizePercentages(this.#state.panes, percentages, minimumPermille);
    if (sizesAreEqual(panes, this.#state.panes)) {
      return;
    }
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
   * Replaces the deck wholesale, which is right for the case it serves: a restore
   * happens once, at mount, against a deck the person has not touched, so there is
   * no second arrangement for it to be wrong about. The case where there IS one — a
   * slow read the person arranged panes through — is {@link adoptBeneath}, which
   * carries the merge rule so this path does not have to.
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

  /**
   * Adopt a snapshot BENEATH an arrangement the person has already made.
   *
   * The other half of {@link restore}, and the reason that one may stay wholesale.
   * The store sits on the far side of a process boundary, so its read takes real time
   * and the deck is live for all of it. A person who arranges panes while it is in
   * flight has made the NEWER arrangement, and replacing it with the record is the
   * window undoing work under their hands.
   *
   * So the deck on screen wins for every address it holds — its ids, its order, its
   * widths — and the record contributes only the addresses it does not, minus
   * `retiredAddressKeys`: the addresses the person CLOSED while the read was running.
   * A close leaves nothing behind in a snapshot, so without that set the record puts
   * the pane straight back.
   *
   * ADOPTED PANES ARE RE-KEYED. A record's pane ids were minted by an earlier run of
   * this deck and the live ones by this run, so the two id spaces collide outright;
   * the live ids are the ones already on screen and already quoted by a focus, a drag,
   * and an ephemeral pane's `sourcePaneId`, so those stand and the arriving panes take
   * fresh ids. The record's own focus is discarded with its id space, under the same
   * rule — the pane the person is looking at is the one they chose last — and a deck
   * focusing nothing takes the first adopted pane rather than staying unfocused.
   */
  public adoptBeneath(
    snapshot: unknown,
    retiredAddressKeys: ReadonlySet<string>,
  ): DeckRestoreReport {
    const decoded = decodeDeckSnapshot(snapshot, this.#restoredPaneCap);
    const liveAddresses = new Set(this.#state.panes.map(paneAddressKey));
    const adopted = decoded.panes
      .filter((pane) => {
        const address = paneAddressKey(pane);
        return !liveAddresses.has(address) && !retiredAddressKeys.has(address);
      })
      .map((pane) => ({ ...pane, paneId: this.#mintPaneId() }));

    // Density is one value with no identity, so there is nothing to merge and no
    // arrangement to lose: the record's stands unless the person has chosen one, and
    // an untouched deck is still at the default the constructor gave it.
    const density =
      this.#state.density === DEFAULT_DECK_DENSITY ? decoded.density : this.#state.density;

    // The record's panes land IN FRONT of the person's. They were open first, and this
    // deck's own rule is that a pane a person opens goes at the end.
    //
    // AND THE LIVE WIDTHS ARE CARRIED THROUGH, which is what makes the sentence above
    // about widths true rather than aspirational. `distributeEvenly` would have given
    // every pane an equal share, so the drag the person finished during the read was
    // equalised away the moment the record contributed one address — the common shape
    // of this path, not an edge of it. `distributeAdoptedBeneath` keeps the live row's
    // proportions and carves the arriving panes' share out of the deck instead.
    //
    // AND THE FOCUS LANDS SOMEWHERE. `close` clears `focusedPaneId` when the closed
    // pane held it, so an open-then-close during the read reaches here with the deck
    // focusing nothing; adopting panes without focusing one leaves the composer with
    // nowhere to send and no way back but a click. The live focus still wins where
    // there is one — the pane the person is looking at is the one they chose last.
    if (adopted.length > 0) {
      this.#commit({
        panes: distributeAdoptedBeneath(adopted, this.#state.panes),
        focusedPaneId: this.#state.focusedPaneId ?? adopted[0]?.paneId,
        density,
      });
    } else if (density !== this.#state.density) {
      this.#commit({ density });
    }
    return { restoredPaneCount: adopted.length, refusals: decoded.refusals };
  }

  /** The next pane id this deck has not used. One counter, one mint. */
  #mintPaneId(): string {
    const paneId = `pane-${String(this.#nextPaneOrdinal)}`;
    this.#nextPaneOrdinal += 1;
    return paneId;
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
