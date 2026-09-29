// The pane layout's live arrangement: which panes exist, in what order, at what widths.
//
// This module holds two of the pane layout's five rules; the other three are the persisted
// grammar's and live in `pane-layout-snapshot.ts`.
//
//   • **One entity, one pane.** One entity opens one pane, structurally — a single
//     pane registry and a tripwire that fails on a second owner. A second open of the same
//     entity FOCUSES the pane that already shows it. The rule is structural here and
//     structural again in the pane registry (`registries/panes/pane-registry.ts`), which is
//     why neither side needs to trust the other.
//   • **Ephemeral panes cascade.** This pane layout's own rule: a `browser` pane opens right
//     of its source and closes with it — so a page nobody asked for cannot outlive
//     the pane that opened it.
//
// STATE LIVES IN THE CLASS, NOT IN REACT. Every mutation goes through a method,
// every method publishes one new immutable `PaneLayoutState`, and React subscribes
// through `useSyncExternalStore`. A component that held pane order in `useState`
// would be a second source of truth for it, and the restore path would have two
// places to write.
//
// This file holds the store and nothing else: the value shapes and the width
// arithmetic are `pane-layout.ts`, the snapshot grammar is `pane-layout-snapshot.ts`, and
// both are pure. What is left here is the one thing that genuinely needs identity —
// the mutable pane layout a session's panes live in.

import { Emitter, type Unsubscribe } from "@renderer/lib/emitter.js";
import { isEphemeralPaneKind } from "@renderer/console/seats/index.js";
import type { PaneAddress, PaneLink } from "@renderer/routing/panes/pane-address.js";
import { DEFAULT_PANE_LAYOUT_DENSITY, type PaneLayoutDensity } from "./pane-layout-measures.js";
import {
  PANE_LAYOUT_TOTAL_PERMILLE,
  addressesMatch,
  applyPaneSizePercentages,
  carveSplitFrom,
  distributeAdoptedBeneath,
  distributeEvenly,
  highestOrdinal,
  paneAddressKey,
  reorder,
  sizesAreEqual,
  type PaneLayoutState,
  type SessionPane,
  type PaneSizePercentages,
} from "./pane-layout.js";
import {
  decodePaneLayoutSnapshot,
  encodePaneLayoutSnapshot,
  type PaneLayoutRestoreReport,
  type PaneLayoutSnapshotRecord,
} from "./pane-layout-snapshot.js";

/**
 * Panes one saved pane layout may restore.
 *
 * The pane layout's own decision, like the third of the three restore rules
 * `pane-layout-snapshot.ts` states — no committed document fixes the
 * number, and the cap is about untrusted input rather than performance: a persisted
 * record is a file on disk, and without a bound a corrupted or hand-edited one mounts
 * panes until the window stops responding. Twelve is past any arrangement a person
 * builds on a display the density presets are drawn for, so the cap binds a
 * defect and never a session.
 */
export const PANE_LAYOUT_RESTORED_PANE_CAP = 12;

/** Construction inputs. */
export interface PaneLayoutStoreOptions {
  readonly density?: PaneLayoutDensity;
  /** Panes a restore may mount. Beyond it the extras are dropped and reported. */
  readonly restoredPaneCap: number;
}

/** The live pane layout of one session screen; every mutation publishes one new state. */
export class PaneLayoutStore {
  readonly #changes = new Emitter<PaneLayoutState>("pane layout change");
  readonly #restoredPaneCap: number;
  #state: PaneLayoutState;
  #nextPaneOrdinal = 1;

  public constructor(options: PaneLayoutStoreOptions) {
    this.#restoredPaneCap = options.restoredPaneCap;
    this.#state = {
      panes: [],
      focusedPaneId: undefined,
      density: options.density ?? DEFAULT_PANE_LAYOUT_DENSITY,
      revision: 0,
    };
  }

  /** The current state. Always the state the last notification carried. */
  public snapshot(): PaneLayoutState {
    return this.#state;
  }

  /** Subscribe to transitions. The `useSyncExternalStore` half. */
  public subscribe(listener: (state: PaneLayoutState) => void): Unsubscribe {
    return this.#changes.subscribe(listener);
  }

  /**
   * Open a pane, or focus the one already showing that entity.
   *
   * Returns the pane id either way, so a caller never has to ask which happened to
   * find the pane it asked for.
   *
   * TWO PLACEMENTS, AND THE LINK DECIDES WHICH. An open with no source pane is
   * an open FROM A LIST — the palette, a rail destination — and lands at
   * the end of the pane layout at an equal share, which is where a person's eye expects a
   * pane they just opened. An open linked to one is the SPLIT act — the pane layout offers
   * open, close, focus, resize, reorder and split — so the pane arrives immediately
   * right of its source and takes half of THAT pane's width, and every other pane in
   * the pane layout keeps the width the person gave it. `carveSplitFrom` holds the arithmetic
   * and says why the two rules differ.
   *
   * A split of a pane too narrow to halve falls back to the list placement rather than
   * refusing the open: the person asked for a pane and gets one, and the pane layout
   * re-divides — the only outcome that leaves every pane wide enough to grab.
   */
  public open(address: PaneAddress, link?: PaneLink): string {
    const entity = "entity" in address ? address.entity : undefined;
    const sourcePaneId = link?.linkedSourcePaneId;
    const existing = this.#state.panes.find((pane) =>
      addressesMatch(pane, { kind: address.kind, entity }),
    );
    if (existing !== undefined) {
      this.focus(existing.paneId);
      return existing.paneId;
    }

    const paneId = this.#mintPaneId();
    const pane: SessionPane = {
      paneId,
      kind: address.kind,
      entity,
      sizePermille: PANE_LAYOUT_TOTAL_PERMILLE,
      isEphemeral: isEphemeralPaneKind(address.kind),
      sourcePaneId,
    };

    const sourcePosition =
      sourcePaneId === undefined
        ? -1
        : this.#state.panes.findIndex((candidate) => candidate.paneId === sourcePaneId);
    if (sourcePosition >= 0) {
      const split = carveSplitFrom(this.#state.panes, sourcePosition, pane);
      if (split !== undefined) {
        this.#commit({ panes: split, focusedPaneId: paneId });
        return paneId;
      }
    }

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

  /** Focus a pane. A pane id the pane layout does not hold changes nothing. */
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
   * Wrapping rather than stopping at the ends: the chord is "cycle the pane layout", and a
   * pane layout of two panes where the forward chord stops working is one the person has to
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
   * A SUBSCRIPTION. `react-resizable-panels` is adopted under one constraint — the
   * layout is store-owned — so the group reports what a drag or an arrow key settled
   * on and this method decides what the pane layout keeps: clamped to the pane layout's own floor,
   * renormalized to the total, and dropped entirely when nothing moved.
   *
   * The no-op guard is load-bearing rather than an optimization. The group reports
   * its layout after every commit, including the ones this method caused; without
   * the guard each report would raise the revision, the raised revision would
   * re-render the group, and the pane layout would settle only because the values stopped
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

  public setDensity(density: PaneLayoutDensity): void {
    if (this.#state.density === density) {
      return;
    }
    this.#commit({ density });
  }

  /** The record the persistence chokepoint stores under the `layout` value class. */
  public toSnapshot(): PaneLayoutSnapshotRecord {
    return encodePaneLayoutSnapshot(this.#state);
  }

  /**
   * Adopt a snapshot, dropping what this build cannot interpret.
   *
   * Replaces the pane layout wholesale, which is right for the case it serves: a restore
   * happens once, at mount, against a pane layout the person has not touched, so there is
   * no second arrangement for it to be wrong about. The case where there IS one — a
   * slow read the person arranged panes through — is {@link adoptBeneath}, which
   * carries the merge rule so this path does not have to.
   */
  public restore(snapshot: unknown): PaneLayoutRestoreReport {
    const decoded = decodePaneLayoutSnapshot(snapshot, this.#restoredPaneCap);
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
   * and the pane layout is live for all of it. A person who arranges panes while it is in
   * flight has made the NEWER arrangement, and replacing it with the record is the
   * window undoing work under their hands.
   *
   * So the pane layout on screen wins for every address it holds — its ids, its order, its
   * widths — and the record contributes only the addresses it does not, minus
   * `retiredAddressKeys`: the addresses the person CLOSED while the read was running.
   * A close leaves nothing behind in a snapshot, so without that set the record puts
   * the pane straight back.
   *
   * ADOPTED PANES ARE RE-KEYED. A record's pane ids were minted by an earlier run of
   * this pane layout and the live ones by this run, so the two id spaces collide outright;
   * the live ids are the ones already on screen and already quoted by a focus, a drag,
   * and an ephemeral pane's `sourcePaneId`, so those stand and the arriving panes take
   * fresh ids. The record's own focus is discarded with its id space, under the same
   * rule — the pane the person is looking at is the one they chose last — and a pane layout
   * focusing nothing takes the first adopted pane rather than staying unfocused.
   */
  public adoptBeneath(
    snapshot: unknown,
    retiredAddressKeys: ReadonlySet<string>,
  ): PaneLayoutRestoreReport {
    const decoded = decodePaneLayoutSnapshot(snapshot, this.#restoredPaneCap);
    const liveAddresses = new Set(this.#state.panes.map(paneAddressKey));
    const adopted = decoded.panes
      .filter((pane) => {
        const address = paneAddressKey(pane);
        return !liveAddresses.has(address) && !retiredAddressKeys.has(address);
      })
      .map((pane) => ({ ...pane, paneId: this.#mintPaneId() }));

    // Density is one value with no identity, so there is nothing to merge and no
    // arrangement to lose: the record's stands unless the person has chosen one, and
    // an untouched pane layout is still at the default the constructor gave it.
    const density =
      this.#state.density === DEFAULT_PANE_LAYOUT_DENSITY ? decoded.density : this.#state.density;

    // The record's panes land IN FRONT of the person's. They were open first, and this
    // pane layout's own rule is that a pane a person opens goes at the end.
    //
    // AND THE LIVE WIDTHS ARE CARRIED THROUGH, which is what makes the sentence above
    // about widths true rather than aspirational. `distributeEvenly` would have given
    // every pane an equal share, so the drag the person finished during the read was
    // equalized away the moment the record contributed one address — the common shape
    // of this path, not an edge of it. `distributeAdoptedBeneath` keeps the live row's
    // proportions and carves the arriving panes' share out of the pane layout instead.
    //
    // AND THE FOCUS LANDS SOMEWHERE. `close` clears `focusedPaneId` when the closed
    // pane held it, so an open-then-close during the read reaches here with the pane layout
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

  /** The next pane id this pane layout has not used. One counter, one mint. */
  #mintPaneId(): string {
    const paneId = `pane-${String(this.#nextPaneOrdinal)}`;
    this.#nextPaneOrdinal += 1;
    return paneId;
  }

  #commit(change: Partial<PaneLayoutState>): void {
    this.#state = { ...this.#state, ...change, revision: this.#state.revision + 1 };
    this.#changes.emit(this.#state);
  }
}
