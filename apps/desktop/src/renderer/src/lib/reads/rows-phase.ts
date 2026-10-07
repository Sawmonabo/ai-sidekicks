// Where a read of a row list has got to, as the view drawing those rows carries it. It holds
// the rows and the count it could not read; a reading's own phase and refusal are
// `wire-state.ts`'s.

/** Where a row list's read has got to: in flight, or answered with any number of rows. */
export type RowsReadPhase<TRow> =
  | { readonly status: "loading" }
  | {
      readonly status: "answered";
      readonly rows: readonly TRow[];
      readonly unreadableCount: number;
    };
