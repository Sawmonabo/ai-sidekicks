import type { Table } from "mdast";
import { useLayoutEffect, useReducer, useState } from "react";

import { piecedRowsOf } from "../parse/pieced-table.js";
import { holdTableRows } from "../parse/table-rows.js";

/**
 * Holds every body row of `table` while the caller is mounted, and answers whether each one can be
 * read now: at once for a table parsed whole, and for a table read in pieces once every piece is
 * kept or parsed again. Throws why a piece could not be parsed again.
 */
export function useHeldTableRows(table: Table): boolean {
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [, redraw] = useReducer(countLandings, 0);
  const rowCount = table.children.length - 1;
  useLayoutEffect(() => {
    if (rowCount <= 0) {
      return undefined;
    }
    let isAsking = true;
    const letGo = holdTableRows(table, 0, rowCount - 1, (readFailure) => {
      if (readFailure !== undefined) {
        setFailure(readFailure);
      } else if (!isAsking) {
        redraw();
      }
    });
    isAsking = false;
    return letGo;
  }, [table, rowCount]);
  if (failure !== undefined) {
    throw new Error(failure);
  }
  const pieced = piecedRowsOf(table);
  if (pieced === undefined) {
    return true;
  }
  for (let index = 0; index < rowCount; index = pieced.pieceSpanOf(index).lastIndex + 1) {
    if (!pieced.isRowRead(index)) {
      return false;
    }
  }
  return true;
}

function countLandings(count: number): number {
  return count + 1;
}
