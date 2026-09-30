// The pane layout's live arrangement: which panes exist, in what order, at what widths.
//
// Two rules live here; the persisted grammar's are in `pane-layout-snapshot.ts`.
//   - One entity, one pane: a second open of the same entity focuses the pane already showing
//     it. The pane registry (`registries/panes/pane-registry.ts`) enforces it again
//     structurally, so neither side trusts the other.
//   - Ephemeral panes cascade: a `browser` pane opens right of its source and closes with it.
//
// State lives in the class rather than React: every mutation publishes one new immutable
// `PaneLayoutState` that React reads through `useSyncExternalStore`, so `useState` never
// becomes a second source of truth. Value shapes and width arithmetic are in `pane-layout.ts`.

import { Emitter, type Unsubscribe } from "@renderer/lib/emitter.js";
import { isEphemeralPaneKind } from "@renderer/routing/panes/pane-kinds.js";
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
 * Panes one saved pane layout may restore. The cap is about untrusted input, not performance:
 * a corrupted or hand-edited record would otherwise mount panes until the window stops
 * responding. Twelve is past any arrangement a person builds, so it binds a defect, not a session.
 */
export const PANE_LAYOUT_RESTORED_PANE_CAP = 12;

/** Construction inputs for a pane layout store. */
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

  /** Subscribes to transitions; the `useSyncExternalStore` half. */
  public subscribe(listener: (state: PaneLayoutState) => void): Unsubscribe {
    return this.#changes.subscribe(listener);
  }

  /**
   * Opens a pane, or focuses the one already showing that entity. Returns the pane id either way.
   *
   * An open with no source pane comes from a list (the palette, a rail destination) and lands at
   * the end at an equal share. An open linked to a source is a split: the pane arrives right of
   * its source and takes half of that pane's width, leaving the others alone. A source too
   * narrow to halve falls back to the list placement rather than refusing the open.
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
   * Closes a pane and every ephemeral pane that opened beside it.
   *
   * The cascade is one level deep, since nothing opens beside a `browser` pane, and is a filter
   * rather than a recursive walk so a cyclic `sourcePaneId` cannot loop.
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

  /** Focuses a pane. A pane id the layout does not hold changes nothing. */
  public focus(paneId: string): void {
    if (
      this.#state.focusedPaneId === paneId ||
      !this.#state.panes.some((pane) => pane.paneId === paneId)
    ) {
      return;
    }
    this.#commit({ focusedPaneId: paneId });
  }

  /** Focuses the next or previous pane, wrapping at the ends. */
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

  /** Moves a pane one position left or right. The keyboard half of drag-reorder. */
  public movePane(paneId: string, step: 1 | -1): void {
    const from = this.#state.panes.findIndex((pane) => pane.paneId === paneId);
    const to = from + step;
    if (from < 0 || to < 0 || to >= this.#state.panes.length) {
      return;
    }
    this.#commit({ panes: reorder(this.#state.panes, from, to) });
  }

  /** Drops a pane at an absolute position. The drag half; clamped, never refused. */
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
   * Adopts the widths the panel group settled on, clamped to `minimumPermille` and renormalized
   * to the total. The store stays the source of truth: the group only reports what a drag or key
   * settled on.
   *
   * The no-op guard is load-bearing: the group reports after every commit, including this
   * method's own, and each unguarded report would raise the revision and re-render the group.
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

  /** Sets the density preset. */
  public setDensity(density: PaneLayoutDensity): void {
    if (this.#state.density === density) {
      return;
    }
    this.#commit({ density });
  }

  /** The record stored under the `layout` value class. */
  public toSnapshot(): PaneLayoutSnapshotRecord {
    return encodePaneLayoutSnapshot(this.#state);
  }

  /**
   * Adopts a snapshot wholesale, dropping what this build cannot interpret. For a layout the
   * person has not touched; one arranged during a slow read uses {@link adoptBeneath}.
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
   * Adopts a snapshot beneath an arrangement the person already made while a slow read ran.
   *
   * The layout on screen wins for every address it holds (ids, order, widths). The record adds
   * only the addresses the layout lacks, minus `retiredAddressKeys`, the addresses closed during
   * the read, since a close leaves nothing in a snapshot. Adopted panes get fresh ids because the
   * record's ids collide with the live ones; the record's focus is discarded, and a layout
   * focusing nothing takes the first adopted pane.
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

    // Density has nothing to merge: the record's stands unless the person chose one, and an
    // untouched layout is still at the default.
    const density =
      this.#state.density === DEFAULT_PANE_LAYOUT_DENSITY ? decoded.density : this.#state.density;

    // The record's panes land in front of the person's, since they were open first. Live widths
    // are carried through by `distributeAdoptedBeneath`; `distributeEvenly` would equalize
    // away the drag the person made during the read.
    //
    // Focus falls to the first adopted pane when nothing is focused (an open then close during
    // the read); otherwise the live focus wins.
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

  /** The next pane id this layout has not used. */
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
