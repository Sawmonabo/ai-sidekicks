/**
 * Delivers a rendered memo to a target once, and settles the outcome: the outbound frame, the
 * target gateway, and the coordinator that keeps a repeat send from duplicating the memo.
 */

import type { DeclaredLossKind } from "@ai-sidekicks/contracts";
import { DECLARED_LOSS_KINDS } from "@ai-sidekicks/contracts";
import type { OutboundTextFrame } from "../outbound-frame.js";
import { OutboundTextFrameWriter } from "../outbound-frame.js";
import {
  EstablishedMemoTarget,
  type MemoBudgetPolicy,
  MemoProjection,
  type MemoRendering,
  type MemoTargetIdentity,
  UnownedMemoTargetError,
} from "./memo-projection.js";
import {
  type MemoContinuityMarkerOccurrence,
  readAnyMemoContinuityMarkerOccurrences,
  targetTurnsCarryAttributableMemoMarker,
  targetTurnsCarryMemoMarker,
} from "./memo-marker-reader.js";
import type { CanonicalTranscriptProjection } from "../provider-driver.js";

/**
 * The frame handed to the gateway, minted `system_narration`; the driver owns encoding. A frame,
 * not a string, so a gateway cannot send bytes that skipped neutralization and correlation minting.
 */
export interface MemoOutboundFrame {
  readonly targetProviderSessionId: string;
  readonly memoIdentityKey: string;
  readonly frame: OutboundTextFrame;
}

/** The target as this floor sees it: the read reconciliation rests on, and the one send. */
export interface MemoTargetGateway {
  /**
   * Turns of the named session (the id `sendMemoTurn` is handed) as text, to decide whether the
   * marker is present. Must cover the whole session, not a tail, or a scrolled-out marker causes a
   * second memo. Rejecting means unreadable and never licenses a send.
   */
  readTurnsForMarkerReconciliation(targetProviderSessionId: string): Promise<readonly string[]>;
  /** Delivers the memo turn. A rejection is ambiguous: the frame may have been applied. */
  sendMemoTurn(frame: MemoOutboundFrame): Promise<void>;
}

/**
 * A caller-supplied bounded wait that resolves once the target has settled any earlier ambiguous
 * send, so an absent marker read afterwards is definitive. Rejecting or absent leaves delivery
 * unconfirmed; a barrier that resolves early is a caller error nothing here can catch.
 */
export type MemoSendSettlementBarrier = () => Promise<void>;

/** One delivery: the projection, the established target, the budget, and an optional barrier. */
export interface MemoDeliveryRequest {
  readonly projection: CanonicalTranscriptProjection;
  /** An established handle, not a bare identity: only its minting coordinator may deliver. */
  readonly target: EstablishedMemoTarget;
  readonly budget: MemoBudgetPolicy;
  /** Optional. Without it an ambiguous send stays unconfirmed; a late memo still settles. */
  readonly sendSettlementBarrier?: MemoSendSettlementBarrier | undefined;
}

/**
 * `delivered` and `already-delivered` mean the target holds the memo; `withheld` means nothing was
 * sent; `unconfirmed` means a send is outstanding and unknown, and persists across calls until
 * evidence moves it.
 */
type MemoDeliveryDisposition = "delivered" | "already-delivered" | "withheld" | "unconfirmed";

/** Why nothing reached the target; `send-refused` needs a later call's barrier, not a rejection. */
type MemoWithheldReason = "target-unreadable" | "send-refused";

/**
 * Which memo `declaredLosses` describes: this call's render, the memo already on the target
 * (possibly rendered under a tighter budget), or `unknown` when its record was unreadable, where
 * the list is the whole producible set as an upper bound.
 */
type MemoDeclaredLossSource = "this-delivery" | "delivered-memo" | "unknown";

/** The outcome of one delivery: its disposition, the declared losses, and the rendering. */
export interface MemoDeliverySettlement {
  /** Always `degraded`: `applied` would tell the user the model sees the conversation. */
  readonly status: "degraded";
  readonly disposition: MemoDeliveryDisposition;
  readonly memoIdentityKey: string;
  readonly declaredLosses: readonly DeclaredLossKind[];
  /** Which memo `declaredLosses` describes. */
  readonly declaredLossSource: MemoDeclaredLossSource;
  readonly withheldReason?: MemoWithheldReason | undefined;
  /** What was rendered, whether or not it was sent. Held in memory only. */
  readonly rendering: MemoRendering;
}

/**
 * Reconciles, then sends, then settles: at most one send per call, only after a read that found no
 * marker and no unresolved earlier send. Guards are in-memory and per coordinator (one delivery
 * per target at a time; an ambiguous send blocks the target); a restart relies on the reconcile.
 */
export class MemoDeliveryCoordinator {
  readonly #gateway: MemoTargetGateway;
  readonly #projection: MemoProjection;
  readonly #frameWriter: OutboundTextFrameWriter;
  /** Targets by provider session id; a foreign handle or a bare `new` is refused by identity. */
  readonly #establishedTargets: Map<string, EstablishedMemoTarget> = new Map<
    string,
    EstablishedMemoTarget
  >();
  /**
   * The delivery in flight into each target id, with the key of the memo it rendered. Target-scoped
   * because two overlapping calls with different keys would each find no marker and both send.
   */
  readonly #deliveriesInFlight: Map<string, MemoDeliveryInFlight> = new Map<
    string,
    MemoDeliveryInFlight
  >();
  /**
   * Targets whose last send was ambiguous (memory only). Keyed by target, not (target, memo), since
   * a grown projection derives a new key. Unbounded on purpose: evicting an entry would give up the
   * guarantee, so entries leave on evidence only.
   */
  readonly #unconfirmedDeliveries: Set<string> = new Set<string>();
  /**
   * Memo keys attempted per target, recorded before dispatch so an ambiguous send's marker is
   * attributable. A marker under an unrecorded key is foreign prose and settles nothing. Unbounded
   * on purpose, like the register above.
   */
  readonly #attemptedMemoIdentityKeysByTarget: Map<string, Set<string>> = new Map<
    string,
    Set<string>
  >();

  /**
   * The frame writer defaults to `emulated`, which neutralizes; a `native` caller supplies its own
   * writer, so an undeclared caller cannot opt out of the boundary.
   */
  constructor(
    gateway: MemoTargetGateway,
    projection: MemoProjection = new MemoProjection(),
    frameWriter: OutboundTextFrameWriter = new OutboundTextFrameWriter({
      mechanismGrade: "emulated",
    }),
  ) {
    this.#gateway = gateway;
    this.#projection = projection;
    this.#frameWriter = frameWriter;
  }

  /**
   * Mints the handle a delivery is addressed to, asserting the target is fresh (which this
   * coordinator cannot verify; see {@link EstablishedMemoTarget}). Idempotent per provider session
   * and never touches the unconfirmed register.
   */
  establishTarget(target: MemoTargetIdentity): EstablishedMemoTarget {
    const alreadyEstablished: EstablishedMemoTarget | undefined = this.#establishedTargets.get(
      target.providerSessionId,
    );
    if (alreadyEstablished !== undefined) {
      return alreadyEstablished;
    }
    const established: EstablishedMemoTarget = new EstablishedMemoTarget(target.providerSessionId);
    this.#establishedTargets.set(target.providerSessionId, established);
    return established;
  }

  async deliver(request: MemoDeliveryRequest): Promise<MemoDeliverySettlement> {
    // Before anything is rendered, read or sent. Thrown, not settled `withheld`, which would assert
    // the target was never sent to.
    if (this.#establishedTargets.get(request.target.providerSessionId) !== request.target) {
      throw new UnownedMemoTargetError(request.target.providerSessionId);
    }

    // Rendering is pure, so overlapping callers may both do it.
    const rendering: MemoRendering = this.#projection.render({
      projection: request.projection,
      target: request.target,
      budget: request.budget,
    });

    const targetProviderSessionId: string = request.target.providerSessionId;
    // One delivery per target at a time. The same key shares the in-flight settlement, even under
    // another budget; a different key waits the flight out, then reconciles against what it seeded.
    // Terminates: an entry leaves the map when its owner settles.
    for (;;) {
      const inFlight: MemoDeliveryInFlight | undefined =
        this.#deliveriesInFlight.get(targetProviderSessionId);
      if (inFlight === undefined) {
        break;
      }
      if (inFlight.memoIdentityKey === rendering.memoIdentityKey) {
        return await inFlight.settlement;
      }
      // Awaited for completion only; this call derives its own settlement from the target.
      await inFlight.settlement.then(
        () => undefined,
        () => undefined,
      );
    }

    const flight: Promise<MemoDeliverySettlement> = this.#reconcileThenSend(request, rendering);
    this.#deliveriesInFlight.set(targetProviderSessionId, {
      memoIdentityKey: rendering.memoIdentityKey,
      settlement: flight,
    });
    try {
      return await flight;
    } finally {
      // Cleared however the flight ended. The unconfirmed register is kept on purpose: an ambiguous
      // send outlives its call.
      this.#deliveriesInFlight.delete(targetProviderSessionId);
    }
  }

  async #reconcileThenSend(
    request: MemoDeliveryRequest,
    rendering: MemoRendering,
  ): Promise<MemoDeliverySettlement> {
    // A target left ambiguous is possibly applied until evidence says otherwise. The barrier is
    // awaited before the read, which is definitive only after the provider settled that send.
    const priorSendUnconfirmed: boolean = this.#unconfirmedDeliveries.has(
      request.target.providerSessionId,
    );
    const priorSendSettled: boolean = priorSendUnconfirmed
      ? await awaitSendSettlement(request)
      : false;

    let priorTurns: readonly string[];
    try {
      priorTurns = await this.#gateway.readTurnsForMarkerReconciliation(
        request.target.providerSessionId,
      );
    } catch {
      // Unreadable: nothing is sent, since a duplicate corrupts the conversation and a missing memo
      // only degrades it. With a send outstanding the honest arm is unconfirmed, not withheld.
      return priorSendUnconfirmed
        ? settle(rendering, "unconfirmed", undefined, thisDeliveryLosses(rendering))
        : settle(rendering, "withheld", "target-unreadable", thisDeliveryLosses(rendering));
    }

    const attributableMemoIdentityKeys: Set<string> = new Set<string>(
      this.#attemptedMemoIdentityKeysByTarget.get(request.target.providerSessionId),
    );
    attributableMemoIdentityKeys.add(rendering.memoIdentityKey);
    if (targetTurnsCarryAttributableMemoMarker(priorTurns, attributableMemoIdentityKeys)) {
      // The one evidence needing no barrier: the target is seeded by this memo, an earlier key this
      // coordinator attempted, or an outstanding send now known applied (it is the only sender
      // into an established target). The target leaves the register and nothing more is sent.
      this.#unconfirmedDeliveries.delete(request.target.providerSessionId);
      return settle(
        rendering,
        "already-delivered",
        undefined,
        deliveredMemoLosses(priorTurns, rendering.memoIdentityKey),
      );
    }

    if (priorSendUnconfirmed) {
      if (!priorSendSettled) {
        // Marker absent and the earlier send may still be applying: report again, send nothing.
        return settle(rendering, "unconfirmed", undefined, thisDeliveryLosses(rendering));
      }
      // The barrier ordered this read behind the earlier send and no marker is there: it did not
      // land. Nothing is sent here, since that is no evidence about a new send; the target leaves
      // the register, so the next delivery is an ordinary first attempt.
      this.#unconfirmedDeliveries.delete(request.target.providerSessionId);
      return settle(rendering, "withheld", "send-refused", thisDeliveryLosses(rendering));
    }

    // Recorded before dispatch so the marker of a send that throws below is attributable.
    let attemptedKeysForTarget: Set<string> | undefined =
      this.#attemptedMemoIdentityKeysByTarget.get(request.target.providerSessionId);
    if (attemptedKeysForTarget === undefined) {
      attemptedKeysForTarget = new Set<string>();
      this.#attemptedMemoIdentityKeysByTarget.set(
        request.target.providerSessionId,
        attemptedKeysForTarget,
      );
    }
    attemptedKeysForTarget.add(rendering.memoIdentityKey);
    try {
      await this.#gateway.sendMemoTurn({
        targetProviderSessionId: request.target.providerSessionId,
        memoIdentityKey: rendering.memoIdentityKey,
        frame: this.#frameWriter.compose({
          text: rendering.text,
          origin: "system_narration",
        }),
      });
      return settle(rendering, "delivered", undefined, thisDeliveryLosses(rendering));
    } catch {
      // Ambiguous; registered before anything can throw. The barrier is not consulted here: nothing
      // proves a send just made has settled, and an unobserved resolve would clear the register and
      // let the next call send a duplicate.
      this.#unconfirmedDeliveries.add(request.target.providerSessionId);
      let turnsAfterSend: readonly string[];
      try {
        turnsAfterSend = await this.#gateway.readTurnsForMarkerReconciliation(
          request.target.providerSessionId,
        );
      } catch {
        return settle(rendering, "unconfirmed", undefined, thisDeliveryLosses(rendering));
      }
      if (targetTurnsCarryMemoMarker(turnsAfterSend, rendering.memoIdentityKey)) {
        // The memo is visibly there, so the unacknowledged send applied; no ordering is needed.
        this.#unconfirmedDeliveries.delete(request.target.providerSessionId);
        // Losses come from the marker; one with no record is not the memo this call composed, so it
        // takes the conservative arm.
        return settle(
          rendering,
          "delivered",
          undefined,
          deliveredMemoLosses(turnsAfterSend, rendering.memoIdentityKey),
        );
      }
      // One absent snapshot while the provider may still be applying is not evidence.
      return settle(rendering, "unconfirmed", undefined, thisDeliveryLosses(rendering));
    }
  }
}

/**
 * Awaits the caller's barrier; true means a readback taken next is definitive. An absent and a
 * rejected barrier both give false, since a bounded wait expiring is the ordinary unanswered case.
 */
async function awaitSendSettlement(request: MemoDeliveryRequest): Promise<boolean> {
  const barrier: MemoSendSettlementBarrier | undefined = request.sendSettlementBarrier;
  if (barrier === undefined) {
    return false;
  }
  try {
    await barrier();
    return true;
  } catch {
    return false;
  }
}

interface MemoDeliveryInFlight {
  readonly memoIdentityKey: string;
  readonly settlement: Promise<MemoDeliverySettlement>;
}

function settle(
  rendering: MemoRendering,
  disposition: MemoDeliveryDisposition,
  withheldReason: MemoWithheldReason | undefined,
  lossRecord: MemoDeclaredLossRecord,
): MemoDeliverySettlement {
  return {
    status: "degraded",
    disposition,
    memoIdentityKey: rendering.memoIdentityKey,
    declaredLosses: lossRecord.losses,
    declaredLossSource: lossRecord.source,
    withheldReason,
    rendering,
  };
}

interface MemoDeclaredLossRecord {
  readonly source: MemoDeclaredLossSource;
  readonly losses: readonly DeclaredLossKind[];
}

function thisDeliveryLosses(rendering: MemoRendering): MemoDeclaredLossRecord {
  return { source: "this-delivery", losses: rendering.declaredLosses };
}

/**
 * Losses recorded by the memo the target holds, for settlements resting on a read marker. Only
 * when every occurrence is a readable record of this memo; otherwise the whole closed vocabulary,
 * as an unparsed marker may hold kinds a newer peer daemon wrote, and understating misleads.
 */
function deliveredMemoLosses(
  targetTurns: readonly string[],
  memoIdentityKey: string,
): MemoDeclaredLossRecord {
  const occurrences: readonly MemoContinuityMarkerOccurrence[] =
    readAnyMemoContinuityMarkerOccurrences(targetTurns);
  const recorded: Set<DeclaredLossKind> = new Set<DeclaredLossKind>();
  for (const occurrence of occurrences) {
    if (occurrence.form !== "recorded" || occurrence.memoIdentityKey !== memoIdentityKey) {
      return { source: "unknown", losses: DECLARED_LOSS_KINDS };
    }
    for (const kind of occurrence.kinds) {
      recorded.add(kind);
    }
  }
  return occurrences.length === 0
    ? { source: "unknown", losses: DECLARED_LOSS_KINDS }
    : { source: "delivered-memo", losses: [...recorded] };
}

/** Thrown when a settlement that established no delivery is asked for a boundary result. */
export class MemoDeliveryNotEstablishedError extends Error {
  readonly settlement: MemoDeliverySettlement;

  constructor(settlement: MemoDeliverySettlement) {
    super(
      `The memo floor established no delivery (${settlement.disposition}${
        settlement.withheldReason === undefined ? "" : `: ${settlement.withheldReason}`
      }); there is no replay result to report.`,
    );
    this.name = "MemoDeliveryNotEstablishedError";
    this.settlement = settlement;
  }
}
