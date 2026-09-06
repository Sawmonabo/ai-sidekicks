// Both sides of the layout snapshot's pane filter, in one module.
//
// `Spec-023 §Console Design (Meridian)` 12.1 says the browser pane is ephemeral, and
// §The surface set says an unknown pane kind read back from a snapshot "is dropped and
// reported". Those are the two rules a layout snapshot has to obey about its panes,
// and this module is both halves of them.
//
// WHY ONE MODULE AND NOT TWO. The write filter and the restore drop are the producer
// and the consumer of one seam, and `apps/desktop/AGENTS.md` puts those in one module
// for the reason this seam demonstrates: written apart, the write side could stop
// filtering a kind and the read side would faithfully restore what it was handed, with
// both files individually correct. Here the two rules are stated once and read twice.
//
// AND THE READ SIDE DOES NOT TRUST THE WRITE SIDE, which is the whole point of the
// duplication that is left. A snapshot on disk was written by whatever build was
// installed when it was written, and a build that predates the ephemeral rule wrote
// browser panes into it. So the restore drops an ephemeral kind even though nothing
// this build writes could have put one there.
//
// THE DECK IS NOT HERE YET. The workspace deck that writes and reads the snapshot is
// the ledger family's, so these two functions are generic over the row shape rather
// than naming one: what they own is the pane-kind decision, and the deck owns the row.

import { isEphemeralPaneKind, isPaneKind, type PaneKind } from "./pane-kinds.js";

/** Why one entry did not come back from a snapshot. */
export type LayoutPaneDropReason = "unknown-kind" | "ephemeral-kind";

/** One dropped entry, as the report the spec asks for. */
export interface LayoutPaneDrop {
  /** Verbatim, and typed `unknown` because it came off disk. */
  readonly kind: unknown;
  readonly reason: LayoutPaneDropReason;
}

/** What a restore read back, and what it refused to. */
export interface LayoutRestoreReading<TEntry> {
  readonly restored: readonly (TEntry & { readonly kind: PaneKind })[];
  readonly dropped: readonly LayoutPaneDrop[];
}

// Consumed by T-023p-1C-2
/**
 * The panes a layout snapshot may carry.
 *
 * Generic over the deck's own pane row, so the deck writes whatever members it holds
 * and this decides only which rows survive.
 */
export function panesForLayoutSnapshot<TPane extends { readonly kind: PaneKind }>(
  panes: readonly TPane[],
): readonly TPane[] {
  return panes.filter((pane) => !isEphemeralPaneKind(pane.kind));
}

// Consumed by T-023p-1C-2
/**
 * The panes a restore may re-open, and the report for the ones it may not.
 *
 * A reading rather than a filtered array, because "dropped and reported" is two
 * obligations and a function that returned only the survivors would meet one of them
 * while making the other unavailable to its caller.
 */
export function panesFromLayoutSnapshot<TEntry extends { readonly kind: unknown }>(
  entries: readonly TEntry[],
): LayoutRestoreReading<TEntry> {
  const restored: (TEntry & { readonly kind: PaneKind })[] = [];
  const dropped: LayoutPaneDrop[] = [];
  for (const entry of entries) {
    if (!isPaneKind(entry.kind)) {
      dropped.push({ kind: entry.kind, reason: "unknown-kind" });
      continue;
    }
    if (isEphemeralPaneKind(entry.kind)) {
      dropped.push({ kind: entry.kind, reason: "ephemeral-kind" });
      continue;
    }
    restored.push(entry as TEntry & { readonly kind: PaneKind });
  }
  return { restored, dropped };
}
