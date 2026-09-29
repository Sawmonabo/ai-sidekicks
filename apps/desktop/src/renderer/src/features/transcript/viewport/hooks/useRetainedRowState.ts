import { useContext } from "react";

import {
  RetainedRowStateContext,
  type LedgerRowLeaseChannel,
} from "../components/RetainedRowStateProvider.js";

/**
 * The retained-state channel for the row being rendered.
 *
 * Throws outside a transcript rather than answering with a stub: a silently discarded
 * write looks exactly like a row that will not open.
 */
export function useLedgerRowLease(): LedgerRowLeaseChannel {
  const channel = useContext(RetainedRowStateContext);
  if (channel === undefined) {
    throw new Error("a ledger row body was mounted outside a ledger row lease provider");
  }
  return channel;
}
