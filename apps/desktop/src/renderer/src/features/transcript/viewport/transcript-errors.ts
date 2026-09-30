// The transcript's error table: one entry per kind, ranked, so a transient failure (a geometry
// read that clears next frame) never overwrites a durable one (a row that cannot be projected).

import { type Refusal } from "@renderer/lib/refusal.js";

/**
 * The four things that fail independently in a transcript, highest rank first. The order
 * is the policy; there is no severity field to disagree with it.
 */
export const TRANSCRIPT_ERROR_KINDS = ["row-projection", "reveal", "prune", "geometry"] as const;

/** One kind of transcript error. */
export type TranscriptErrorKind = (typeof TRANSCRIPT_ERROR_KINDS)[number];

/** What one entry holds. */
export interface TranscriptErrorEntry {
  readonly kind: TranscriptErrorKind;
  readonly refusal: Refusal;
}

/**
 * The transcript's error table.
 *
 * A class rather than component state because the producers report from outside a render:
 * the reveal engine's diagnostics, the window's prune outcome and the scroll controller's
 * geometry.
 */
export class TranscriptErrorTable {
  readonly #refusalByKind = new Map<TranscriptErrorKind, Refusal>();

  public record(kind: TranscriptErrorKind, refusal: Refusal): void {
    this.#refusalByKind.set(kind, refusal);
  }

  /** Clear one kind's entry; the others are untouched. */
  public clear(kind: TranscriptErrorKind): void {
    this.#refusalByKind.delete(kind);
  }

  /** Every recorded entry, in rank order. */
  public entries(): readonly TranscriptErrorEntry[] {
    return TRANSCRIPT_ERROR_KINDS.flatMap((kind) => {
      const refusal = this.#refusalByKind.get(kind);
      return refusal === undefined ? [] : [{ kind, refusal }];
    });
  }

  /** The entry a view with room for one renders. */
  public highest(): TranscriptErrorEntry | undefined {
    return this.entries()[0];
  }

  public get recordedKindCount(): number {
    return this.#refusalByKind.size;
  }
}
