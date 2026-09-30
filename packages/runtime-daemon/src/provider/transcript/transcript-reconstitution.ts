/**
 * Chooses between a provider's native replay and the memo when a transcript is rebuilt on a new
 * target, and renders the disclosure a memo delivery adds.
 */

import type { DeclaredLossKind, DriverTranscriptReplayResult } from "@ai-sidekicks/contracts";
import {
  type MemoDeliveryCoordinator,
  MemoDeliveryNotEstablishedError,
  type MemoDeliveryRequest,
  type MemoDeliverySettlement,
} from "./memo-delivery.js";

/**
 * Maps a settlement to the driver-boundary result (`degraded`, never `applied`). `withheld` and
 * `unconfirmed` throw `MemoDeliveryNotEstablishedError` because the result has no failure arm. The
 * loss list is unqualified here; `renderReconstitutionDisclosure` states its subject.
 */
export function memoSettlementAsReplayResult(
  settlement: MemoDeliverySettlement,
): DriverTranscriptReplayResult {
  switch (settlement.disposition) {
    case "delivered":
    case "already-delivered":
      return { status: "degraded", declaredLosses: [...settlement.declaredLosses] };
    case "withheld":
    case "unconfirmed":
      throw new MemoDeliveryNotEstablishedError(settlement);
    default: {
      // Exhaustive: a new disposition is a type error here.
      void (settlement.disposition satisfies never);
      throw new MemoDeliveryNotEstablishedError(settlement);
    }
  }
}

/** What the caller's native-replay attempt came to, as a value; this module calls no driver. */
export type NativeReplayDisposition =
  | { readonly outcome: "applied"; readonly declaredLosses: readonly DeclaredLossKind[] }
  | { readonly outcome: "unavailable" }
  | { readonly outcome: "refused" }
  | { readonly outcome: "context-window-exceeded" };

/**
 * What one reconstitution came to, per route. The memo arm carries the settlement, not a replay
 * result, so the type cannot hold a result for a memo that never landed.
 */
export type ReconstitutionSettlement =
  | { readonly route: "native-replay"; readonly result: DriverTranscriptReplayResult }
  | { readonly route: "memo"; readonly memo: MemoDeliverySettlement };

/**
 * Raised when a native replay is reported `applied` yet declares `conversation_history_summarized`;
 * the two are exclusive. The schema refuses it at parse, but this router builds results unparsed.
 * Thrown, not corrected: only the caller knows which claim is true.
 */
export class ContradictoryReplayDispositionError extends Error {
  readonly disposition: NativeReplayDisposition;

  constructor(disposition: NativeReplayDisposition) {
    super(
      "A native-replay disposition reported 'applied' while declaring " +
        "'conversation_history_summarized', which names the memo floor standing in for " +
        "the conversation; a replay cannot both have landed the conversation and have " +
        "been summarized away, so no reconstitution settlement is reported for it.",
    );
    this.name = "ContradictoryReplayDispositionError";
    this.disposition = disposition;
  }
}

/** Routes a reconstitution to native replay's settlement or the memo floor. */
export class TranscriptReconstitutionRouter {
  readonly #coordinator: MemoDeliveryCoordinator;

  constructor(coordinator: MemoDeliveryCoordinator) {
    this.#coordinator = coordinator;
  }

  async route(
    disposition: NativeReplayDisposition,
    request: MemoDeliveryRequest,
  ): Promise<ReconstitutionSettlement> {
    if (disposition.outcome === "applied") {
      // Checked here: this result is built from a literal, never parsed, and the flat type cannot
      // enforce the schema's arm scoping.
      if (disposition.declaredLosses.includes("conversation_history_summarized")) {
        throw new ContradictoryReplayDispositionError(disposition);
      }
      return {
        route: "native-replay",
        result: { status: "applied", declaredLosses: [...disposition.declaredLosses] },
      };
    }
    // Returned for every disposition, unlanded ones included: a withheld or unconfirmed delivery is
    // a report the user is owed. A caller owing a boundary result uses
    // `memoSettlementAsReplayResult` and takes its throw.
    const memo: MemoDeliverySettlement = await this.#coordinator.deliver(request);
    return { route: "memo", memo };
  }
}

/**
 * The one renderer both routes pass through, so an applied replay and a memo settlement (landed
 * or not) never read the same; a degraded one reading as applied would hide the summary.
 */
export function renderReconstitutionDisclosure(settlement: ReconstitutionSettlement): string {
  const declaredLosses: readonly DeclaredLossKind[] =
    settlement.route === "native-replay"
      ? settlement.result.declaredLosses
      : settlement.memo.declaredLosses;
  const losses: string =
    declaredLosses.length === 0 ? "nothing was dropped" : declaredLosses.join(", ");

  if (settlement.route === "native-replay") {
    // "In full" is a claim an applied replay may make only when its declared-loss list is empty;
    // "In full" only when nothing was dropped; beside a loss list it contradicts itself.
    return settlement.result.declaredLosses.length === 0
      ? `The prior conversation was replayed into the new session in full (${losses}).`
      : `The prior conversation was replayed into the new session, apart from what could not be carried across (${losses}).`;
  }

  // A settlement resting on an existing summary knows only what that summary recorded; where it
  // recorded nothing, state an upper bound as one.
  const memoLosses: string =
    settlement.memo.declaredLossSource === "unknown"
      ? `what that summary dropped is not recorded; at most ${losses}`
      : losses;

  switch (settlement.memo.disposition) {
    case "delivered":
      return `The prior conversation was summarized rather than replayed; the new session holds a bounded summary of it (${memoLosses}).`;
    case "already-delivered":
      return `The prior conversation was summarized rather than replayed; the new session already held that summary and it was not sent again (${memoLosses}).`;
    case "withheld":
      return `The prior conversation was summarized rather than replayed, and the summary did not reach the new session (${memoLosses}).`;
    case "unconfirmed":
      return `The prior conversation was summarized rather than replayed, and whether the summary reached the new session could not be confirmed (${memoLosses}).`;
    default:
      return `The prior conversation was summarized rather than replayed (${memoLosses}).`;
  }
}
