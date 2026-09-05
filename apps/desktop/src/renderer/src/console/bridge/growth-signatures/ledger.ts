// The ledger plane: one event's hydrated body, and the session's cost fold.
//
// One plane of `GrowthOperationSignatures`, composed into it by `index.ts`. Two of
// the file's own sections — `event content` and `session cost` — share a module
// because they share a reader: the ledger surfaces render a row's body beside what
// the session has spent, and neither section is more than a read and its shape. The
// section comments below are the file's own and are kept apart, so the seam between
// them is still legible.

import type { HydratedSessionEvent } from "@ai-sidekicks/contracts";

import type { GrowthBudgetState, GrowthCostReceipt } from "../growth-values/index.js";

export interface LedgerGrowthSignatures {
  // event content
  //
  // The one operation whose value is a type `packages/contracts` already exports
  // rather than a shape derived here. That is not a shortcut: the projection is
  // deliberately a PAIR — a byte-identical event beside a closed two-arm `content`
  // union — and a console shape that flattened the body into the event would be the
  // splice the registered type exists to prevent, since the payload schemas are
  // strict and the signature covers their bytes. So the console reads the registered
  // projection or it reads nothing.
  //
  // The request is keyed by event rather than by cursor range: a ledger row opens the
  // body it is about to render, and a range read would be a batching decision made
  // ahead of the surface that would need it.
  hydratedEventRead: {
    request: { readonly sessionId: string; readonly eventId: string };
    value: HydratedSessionEvent;
  };
  // session cost
  //
  // Two reads of one fold, and the receipt carries the budget state rather than
  // restating its figures, so the decomposition and the enforced number are the same
  // value and cannot drift. A surface that wants only the total calls
  // `orchestrationBudgetRead`; one that wants the breakdown calls
  // `orchestrationCostReceiptRead` and finds the total inside it.
  orchestrationCostReceiptRead: {
    request: { readonly sessionId: string };
    value: GrowthCostReceipt;
  };
  orchestrationBudgetRead: { request: { readonly sessionId: string }; value: GrowthBudgetState };
}
