import { useContext } from "react";

import {
  RetainedRowStateContext,
  type RetainedRowStateContextValue,
} from "../components/RetainedRowStateProvider.js";

/**
 * The retained-state channel for the row being rendered.
 *
 * Throws outside a transcript rather than answering with a stub: a silently discarded
 * write looks exactly like a row that will not open.
 */
export function useRetainedRowState(): RetainedRowStateContextValue {
  const channel = useContext(RetainedRowStateContext);
  if (channel === undefined) {
    throw new Error("a ledger row body was mounted outside a ledger row lease provider");
  }
  return channel;
}
