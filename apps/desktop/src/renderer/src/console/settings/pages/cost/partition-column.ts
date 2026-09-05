// What a split's table is drawn with: one column's heading, and how a row fills it.
//
// A type of its own beside the table that consumes it and the three column sets that
// build against it. It lives here rather than in any one of those four because it
// belongs to all of them, and putting it in the table would make each column set
// import the component it is passed to.

import type { ReactNode } from "react";

/** One column of a split's table: its heading, and how a row fills it. */
export interface PartitionColumn<TRow> {
  readonly label: string;
  /** True for the money column, which shares one right edge down the table. */
  readonly isAmount?: boolean;
  readonly render: (row: TRow) => ReactNode;
}
