import { useContext } from "react";

import { RowToggleContext, type RowToggle } from "../RowToggleProvider.js";

/**
 * The toggles for the row being rendered.
 *
 * Throws outside a transcript rather than answering with a stub: a silently discarded press looks
 * exactly like a call that will not fold.
 */
export function useRowToggle(): RowToggle {
  const rowToggle = useContext(RowToggleContext);
  if (rowToggle === undefined) {
    throw new Error("a transcript row body was mounted outside a row toggle provider");
  }
  return rowToggle;
}
