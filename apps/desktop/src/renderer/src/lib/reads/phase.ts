// Where one read has got to, as a view that renders from the read carries it.

/** Where one read has got to: in flight, or answered with any number of rows, including none. */
export type ReadPhase<TRow> =
  | { readonly status: "loading" }
  | {
      readonly status: "answered";
      readonly rows: readonly TRow[];
      readonly unreadableCount: number;
    };
