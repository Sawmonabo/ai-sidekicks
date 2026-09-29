// The transcript's error slots: one per kind, ranked, so a transient failure never
// clobbers the durable one a person is about to retry.
//
// Four things fail independently and at different rates: a geometry read fails once and
// clears on the next frame, while a row that cannot be projected fails every render and
// needs a person to act. A single "last error" field would let the first overwrite the
// second; one slot per kind, read in a fixed order, makes that unrepresentable.

import { type Refusal } from "@renderer/lib/refusal.js";

/**
 * The four things that fail independently in a transcript, highest rank first. The order
 * is the policy; there is no severity field to disagree with it.
 */
export const TRANSCRIPT_ERROR_KINDS = ["row-projection", "reveal", "prune", "geometry"] as const;

/** One error slot. */
export type TranscriptErrorKind = (typeof TRANSCRIPT_ERROR_KINDS)[number];

/** What one slot holds. */
export interface TranscriptErrorEntry {
  readonly kind: TranscriptErrorKind;
  readonly refusal: Refusal;
}

/**
 * The transcript's error slots.
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

  /** Clear one slot; the others are untouched. */
  public clear(kind: TranscriptErrorKind): void {
    this.#refusalByKind.delete(kind);
  }

  /** Every occupied slot, in rank order. */
  public entries(): readonly TranscriptErrorEntry[] {
    return TRANSCRIPT_ERROR_KINDS.flatMap((kind) => {
      const refusal = this.#refusalByKind.get(kind);
      return refusal === undefined ? [] : [{ kind, refusal }];
    });
  }

  /** The slot a surface with room for one renders. */
  public highest(): TranscriptErrorEntry | undefined {
    return this.entries()[0];
  }

  public get recordedKindCount(): number {
    return this.#refusalByKind.size;
  }
}
