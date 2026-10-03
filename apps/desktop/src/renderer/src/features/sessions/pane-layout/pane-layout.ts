// The pane shape, the state shape, and the arithmetic that keeps a row of panes summing to a
// whole layout. Stateless, pure and free of React. Imports run one way:
// `pane-layout-store` → `pane-layout-snapshot` → `pane-layout`.

import type { EntityRef } from "@renderer/lib/entity-kinds.js";
import type { PaneKind } from "@renderer/routing/panes/pane-kinds.js";
import type { PaneLayoutDensity } from "./pane-layout-measures.js";

/**
 * Pane widths are carried as permille of the pane layout, summing to this.
 *
 * Integers because the value is persisted and floats accumulate error through JSON; permille
 * rather than percent so five panes divide evenly.
 */
export const PANE_LAYOUT_TOTAL_PERMILLE = 1000;

/** One pane in the pane layout. Immutable; every mutation produces a new one. */
export interface SessionPane {
  /** Stable across a layout restore; the identity `PaneContext` carries. */
  readonly paneId: string;
  readonly kind: PaneKind;
  /** The entity this pane is a view of, or `undefined` for a session-scoped pane. */
  readonly entity: EntityRef | undefined;
  /** This pane's share of the pane layout, in permille. */
  readonly sizePermille: number;
  /** True for a pane that is never persisted and cascades closed with its source. */
  readonly isEphemeral: boolean;
  /** The pane this one opened beside, when it opened beside one. */
  readonly sourcePaneId: string | undefined;
}

/** What React renders from. A fresh object per mutation, so `Object.is` decides. */
export interface PaneLayoutState {
  readonly panes: readonly SessionPane[];
  readonly focusedPaneId: string | undefined;
  readonly density: PaneLayoutDensity;
  /** Monotonic, so a test can count transitions rather than infer them. */
  readonly revision: number;
}

/**
 * The separator between an address key's fields: a control character no kind or id carries.
 * The key stays injective regardless, since the one free-form field, the entity id, is last.
 */
const ADDRESS_KEY_SEPARATOR = "\u001f";

/**
 * One pane address as a string that is equal to another exactly when both name the same pane.
 *
 * Kind plus entity, because one entity can be open in two panes of different kinds. A key
 * rather than a predicate so the snapshot decoder can test "already adopted" in a set instead
 * of quadratically. Takes only the two members an address is made of, so a `SessionPane` and
 * an opened address are keyed by the same call.
 */
export function paneAddressKey(address: Pick<SessionPane, "kind" | "entity">): string {
  const { entity } = address;
  return entity === undefined
    ? `${address.kind}${ADDRESS_KEY_SEPARATOR}`
    : `${address.kind}${ADDRESS_KEY_SEPARATOR}${entity.kind}${ADDRESS_KEY_SEPARATOR}${entity.id}`;
}

/** Whether an open pane is already the pane an address asks for, by {@link paneAddressKey}. */
export function addressesMatch(
  pane: SessionPane,
  address: Pick<SessionPane, "kind" | "entity">,
): boolean {
  return paneAddressKey(pane) === paneAddressKey(address);
}

/** Moves one pane from `from` to `to`. Returns the input unchanged on a bad index. */
export function reorder(
  panes: readonly SessionPane[],
  from: number,
  to: number,
): readonly SessionPane[] {
  const next = [...panes];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) {
    return panes;
  }
  next.splice(to, 0, moved);
  return next;
}

/** Gives every pane an equal share, as opening and closing leave the row. */
export function distributeEvenly(panes: readonly SessionPane[]): readonly SessionPane[] {
  if (panes.length === 0) {
    return panes;
  }
  const share = Math.floor(PANE_LAYOUT_TOTAL_PERMILLE / panes.length);
  return panes.map((pane, position) => ({
    ...pane,
    // The remainder goes to the first pane, so the sum is exact.
    sizePermille: position === 0 ? PANE_LAYOUT_TOTAL_PERMILLE - share * (panes.length - 1) : share,
  }));
}

/**
 * Permille per percent: the translation between the persisted integer permille and the
 * float percentages (0..100) `react-resizable-panels` speaks.
 */
export const PERMILLE_PER_PERCENT: number = PANE_LAYOUT_TOTAL_PERMILLE / 100;

/** A layout as the panels library states it: panel id to percentage of the group. */
export type PaneSizePercentages = Readonly<Record<string, number>>;

/** The store's widths as the percentages the panel group takes as its default. */
export function toPaneSizePercentages(panes: readonly SessionPane[]): PaneSizePercentages {
  const percentages: Record<string, number> = {};
  for (const pane of panes) {
    percentages[pane.paneId] = pane.sizePermille / PERMILLE_PER_PERCENT;
  }
  return percentages;
}

/**
 * Adopts the layout the panel group settled on, holding every pane above `minimumPermille`.
 *
 * The floor is applied here as well as by the library, because the library clamps measured
 * pixels during a drag while this clamps the value that is persisted and restored later. A pane
 * the group does not name keeps its width (it may be mid-mount). The floor is capped at an
 * equal share, since a floor not every pane can meet has no solution.
 */
export function applyPaneSizePercentages(
  panes: readonly SessionPane[],
  percentages: PaneSizePercentages,
  minimumPermille: number,
): readonly SessionPane[] {
  const floor = Math.max(
    0,
    Math.min(minimumPermille, Math.floor(PANE_LAYOUT_TOTAL_PERMILLE / panes.length)),
  );
  return settleToTotal(
    panes.map((pane) => {
      const percentage = percentages[pane.paneId];
      if (percentage === undefined) {
        return pane;
      }
      return {
        ...pane,
        sizePermille: Math.max(floor, Math.round(percentage * PERMILLE_PER_PERCENT)),
      };
    }),
    floor,
  );
}

/** Whether two width sets are the same, so a no-op write-back commits nothing. */
export function sizesAreEqual(
  left: readonly SessionPane[],
  right: readonly SessionPane[],
): boolean {
  return (
    left.length === right.length &&
    left.every((pane, position) => pane.sizePermille === right[position]?.sizePermille)
  );
}

/**
 * Makes a clamped row sum to the whole again without breaking the floor.
 *
 * `normalize` cannot, because rescaling by one ratio would pull a pane raised to the floor back
 * under it. Drift is taken from the panes with the most headroom first, and a shortfall goes
 * to the widest pane. One pass over a sorted copy.
 */
function settleToTotal(panes: readonly SessionPane[], floor: number): readonly SessionPane[] {
  const sizes = panes.map((pane) => pane.sizePermille);
  let drift = sizes.reduce((sum, size) => sum + size, 0) - PANE_LAYOUT_TOTAL_PERMILLE;
  const byHeadroom = sizes
    .map((size, position) => ({ position, size }))
    .sort((left, right) => right.size - left.size);

  for (const candidate of byHeadroom) {
    if (drift === 0) {
      break;
    }
    const current = sizes[candidate.position] ?? 0;
    // Widening has no ceiling; narrowing stops at the floor.
    const adjustment = drift > 0 ? -Math.min(drift, current - floor) : -drift;
    sizes[candidate.position] = current + adjustment;
    drift += adjustment;
  }

  return panes.map((pane, position) => ({
    ...pane,
    sizePermille: sizes[position] ?? pane.sizePermille,
  }));
}

/** The narrowest a rescaled pane may become; a zero-width column cannot be grabbed. */
const MINIMUM_NORMALIZED_PERMILLE = 1;

/**
 * Places arriving panes in front of an arrangement a person already made.
 *
 * {@link distributeEvenly}'s counterpart for the merge path, which must not equalize widths the
 * person just dragged. The live row already fills the total, so each arriving pane takes the
 * equal share it would have had if all had opened together, and the live row is rescaled into
 * what is left in proportion to its widths. {@link settleToTotal} fixes the rounding remainder.
 */
export function distributeAdoptedBeneath(
  adopted: readonly SessionPane[],
  live: readonly SessionPane[],
): readonly SessionPane[] {
  if (adopted.length === 0) {
    return live;
  }
  if (live.length === 0) {
    return distributeEvenly(adopted);
  }
  const adoptedShare = Math.floor(PANE_LAYOUT_TOTAL_PERMILLE / (adopted.length + live.length));
  const liveBudget = PANE_LAYOUT_TOTAL_PERMILLE - adoptedShare * adopted.length;
  const liveTotal = live.reduce((sum, pane) => sum + pane.sizePermille, 0);
  return settleToTotal(
    [
      ...adopted.map((pane) => ({ ...pane, sizePermille: adoptedShare })),
      ...live.map((pane) => ({
        ...pane,
        sizePermille: Math.max(
          MINIMUM_NORMALIZED_PERMILLE,
          liveTotal <= 0
            ? Math.floor(liveBudget / live.length)
            : Math.round((pane.sizePermille / liveTotal) * liveBudget),
        ),
      })),
    ],
    MINIMUM_NORMALIZED_PERMILLE,
  );
}

/**
 * Rescales restored sizes so they sum to the total, whatever was on disk.
 *
 * Rounding alone does not sum (three equal widths become 333 + 333 + 333 = 999), and these
 * widths come from the untrusted persisted snapshot. The remainder is settled after rounding
 * by {@link settleToTotal}: the widest pane first, ties in the panes' own order, so one snapshot
 * always restores to one arrangement.
 */
export function normalize(panes: readonly SessionPane[]): readonly SessionPane[] {
  const total = panes.reduce((sum, pane) => sum + pane.sizePermille, 0);
  if (panes.length === 0 || total <= 0) {
    return distributeEvenly(panes);
  }
  return settleToTotal(
    panes.map((pane) => ({
      ...pane,
      sizePermille: Math.max(
        MINIMUM_NORMALIZED_PERMILLE,
        Math.round((pane.sizePermille / total) * PANE_LAYOUT_TOTAL_PERMILLE),
      ),
    })),
    MINIMUM_NORMALIZED_PERMILLE,
  );
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

/**
 * Places an arriving pane by halving one pane's share and leaving every other pane alone.
 *
 * The split width rule: re-dividing the whole row would resize panes the person did not touch.
 * The arriving pane takes half the source's share and the source keeps the rest, so an odd
 * share leaves the source wider and the sum is preserved. Returns `undefined` when the source
 * is too narrow to halve, so the caller applies its own fallback.
 */
export function carveSplitFrom(
  panes: readonly SessionPane[],
  sourcePosition: number,
  arriving: SessionPane,
): readonly SessionPane[] | undefined {
  const source = panes[sourcePosition];
  if (source === undefined) {
    return undefined;
  }
  const arrivingShare = Math.floor(source.sizePermille / 2);
  if (arrivingShare < MINIMUM_NORMALIZED_PERMILLE) {
    return undefined;
  }
  const split = [...panes];
  split.splice(
    sourcePosition,
    1,
    { ...source, sizePermille: source.sizePermille - arrivingShare },
    { ...arriving, sizePermille: arrivingShare },
  );
  return split;
}
