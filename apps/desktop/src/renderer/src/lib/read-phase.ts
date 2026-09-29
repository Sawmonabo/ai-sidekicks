// Where one read has got to, as a surface that renders from the read carries it.

/**
 * Where one read has got to.
 *
 * Two arms because these are two different sentences and collapsing them is wrong: a
 * read is in flight, or a read answered (with however many rows, including none).
 */
export type ReadPhase<TRow> =
  | { readonly status: "loading" }
  | {
      readonly status: "answered";
      readonly rows: readonly TRow[];
      readonly unreadableCount: number;
    };
