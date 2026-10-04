/**
 * Delivers a rendered brief to a target once, and settles the outcome: the outbound frame, the
 * target gateway, and the coordinator that keeps a repeat send from duplicating the brief.
 */

import type { DeclaredLossKind } from "@ai-sidekicks/contracts/provider-driver-transcript";
import { DECLARED_LOSS_KINDS } from "@ai-sidekicks/contracts/provider-driver-transcript";
import type { OutboundTextFrame } from "../outbound-frame.js";
import { OutboundTextFrameWriter } from "../outbound-frame.js";
import {
  EstablishedBriefTarget,
  type BriefBudgetPolicy,
  BriefProjection,
  type BriefRendering,
  type BriefTargetIdentity,
  UnownedBriefTargetError,
} from "./hand-over-brief.js";
import {
  type BriefContinuityMarkerOccurrence,
  readAnyBriefContinuityMarkerOccurrences,
  targetTurnsCarryAttributableBriefMarker,
  targetTurnsCarryBriefMarker,
} from "./brief-marker-reader.js";
import type { CanonicalTranscriptProjection } from "../provider-driver.js";

/**
 * The frame handed to the gateway, minted `system_narration`; the driver owns encoding. A frame,
 * not a string, so a gateway cannot send bytes that skipped neutralization and correlation minting.
 */
export interface BriefOutboundFrame {
  readonly targetProviderSessionId: string;
  readonly briefIdentityKey: string;
  readonly frame: OutboundTextFrame;
}

/** The target as this floor sees it: the read reconciliation rests on, and the one send. */
export interface BriefTargetGateway {
  /**
   * Turns of the named session (the id `sendBriefTurn` is handed) as text, to decide whether the
   * marker is present. Must cover the whole session, not a tail, or a scrolled-out marker causes a
   * second brief. Rejecting means unreadable and never licenses a send.
   */
  readTurnsForMarkerReconciliation(targetProviderSessionId: string): Promise<readonly string[]>;
  /** Delivers the brief turn. A rejection is ambiguous: the frame may have been applied. */
  sendBriefTurn(frame: BriefOutboundFrame): Promise<void>;
}

/**
 * A caller-supplied bounded wait that resolves once the target has settled any earlier ambiguous
 * send, so an absent marker read afterwards is definitive. Rejecting or absent leaves delivery
 * unconfirmed; a barrier that resolves early is a caller error nothing here can catch.
 */
export type BriefSendSettlementBarrier = () => Promise<void>;

/** One delivery: the projection, the established target, the budget, and an optional barrier. */
export interface BriefDeliveryRequest {
  readonly projection: CanonicalTranscriptProjection;
  /** An established handle, not a bare identity: only its minting coordinator may deliver. */
  readonly target: EstablishedBriefTarget;
  readonly budget: BriefBudgetPolicy;
  /** Optional. Without it an ambiguous send stays unconfirmed; a late brief still settles. */
  readonly sendSettlementBarrier?: BriefSendSettlementBarrier | undefined;
}

/**
 * `delivered` and `already-delivered` mean the target holds the brief; `withheld` means nothing was
 * sent; `unconfirmed` means a send is outstanding and unknown, and persists across calls until
 * evidence moves it.
 */
type BriefDeliveryDisposition = "delivered" | "already-delivered" | "withheld" | "unconfirmed";

/** Why nothing reached the target; `send-refused` needs a later call's barrier, not a rejection. */
type BriefWithheldReason = "target-unreadable" | "send-refused";

/**
 * Which brief `declaredLosses` describes: this call's render, the brief already on the target
 * (possibly rendered under a tighter budget), or `unknown` when its record was unreadable, where
 * the list is the whole producible set as an upper bound.
 */
type BriefDeclaredLossSource = "this-delivery" | "delivered-brief" | "unknown";

/** The outcome of one delivery: its disposition, the declared losses, and the rendering. */
export interface BriefDeliverySettlement {
  /** Always `degraded`: `applied` would tell the user the model sees the conversation. */
  readonly status: "degraded";
  readonly disposition: BriefDeliveryDisposition;
  readonly briefIdentityKey: string;
  readonly declaredLosses: readonly DeclaredLossKind[];
  /** Which brief `declaredLosses` describes. */
  readonly declaredLossSource: BriefDeclaredLossSource;
  readonly withheldReason?: BriefWithheldReason | undefined;
  /** What was rendered, whether or not it was sent. Held in memory only. */
  readonly rendering: BriefRendering;
  /** The gateway error behind an unreadable target or an ambiguous send, when one was thrown. */
  readonly cause?: unknown;
}

/**
 * Reconciles, then sends, then settles: at most one send per call, only after a read that found no
 * marker and no unresolved earlier send. Guards are in-memory and per coordinator (one delivery
 * per target at a time; an ambiguous send blocks the target); a restart relies on the reconcile.
 */
export class BriefDeliveryCoordinator {
  readonly #gateway: BriefTargetGateway;
  readonly #projection: BriefProjection;
  readonly #frameWriter: OutboundTextFrameWriter;
  /** Targets by provider session id; a foreign handle or a bare `new` is refused by identity. */
  readonly #establishedTargets: Map<string, EstablishedBriefTarget> = new Map<
    string,
    EstablishedBriefTarget
  >();
  /**
   * The delivery in flight into each target id, with the key of the brief it rendered.
   * Target-scoped because two overlapping calls with different keys would each find no marker and
   * both send.
   */
  readonly #deliveriesInFlight: Map<string, BriefDeliveryInFlight> = new Map<
    string,
    BriefDeliveryInFlight
  >();
  /**
   * Targets whose last send was ambiguous (memory only). Keyed by target, not (target, brief),
   * since a grown projection derives a new key. Never evicted, since that would give up the
   * guarantee: an entry leaves on evidence, or with its target when the target's session ends.
   */
  readonly #unconfirmedDeliveries: Set<string> = new Set<string>();
  /**
   * Brief keys attempted per target, recorded before dispatch so an ambiguous send's marker is
   * attributable. A marker under an unrecorded key is foreign prose and settles nothing. Never
   * evicted, like the register above, and released with its target.
   */
  readonly #attemptedBriefIdentityKeysByTarget: Map<string, Set<string>> = new Map<
    string,
    Set<string>
  >();

  /**
   * The frame writer defaults to `emulated`, which neutralizes; a `native` caller supplies its own
   * writer, so an undeclared caller cannot opt out of the boundary.
   */
  constructor(
    gateway: BriefTargetGateway,
    projection: BriefProjection = new BriefProjection(),
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
   * coordinator cannot verify; see {@link EstablishedBriefTarget}). Idempotent per provider session
   * and never touches the unconfirmed register.
   */
  establishTarget(target: BriefTargetIdentity): EstablishedBriefTarget {
    const alreadyEstablished: EstablishedBriefTarget | undefined = this.#establishedTargets.get(
      target.providerSessionId,
    );
    if (alreadyEstablished !== undefined) {
      return alreadyEstablished;
    }
    const established: EstablishedBriefTarget = new EstablishedBriefTarget(
      target.providerSessionId,
    );
    this.#establishedTargets.set(target.providerSessionId, established);
    return established;
  }

  /**
   * Forgets a target whose provider session has ended: its handle stops delivering and its
   * registers are dropped. A delivery in flight still settles for its caller, and what it records
   * after this call is dropped when it settles.
   */
  releaseTarget(providerSessionId: string): void {
    this.#establishedTargets.delete(providerSessionId);
    this.#dropTargetRegisters(providerSessionId);
  }

  /** Delivers the brief into the established target at most once and settles what happened. */
  async deliver(request: BriefDeliveryRequest): Promise<BriefDeliverySettlement> {
    // Before anything is rendered, read or sent. Thrown, not settled `withheld`, which would assert
    // the target was never sent to.
    this.#assertOwnedTarget(request.target);

    // Rendering is pure, so overlapping callers may both do it.
    const rendering: BriefRendering = this.#projection.render({
      projection: request.projection,
      target: request.target,
      budget: request.budget,
    });

    const targetProviderSessionId: string = request.target.providerSessionId;
    // One delivery per target at a time. The same key shares the in-flight settlement, even under
    // another budget; a different key waits the flight out, then reconciles against what it seeded.
    // Terminates: an entry leaves the map when its owner settles.
    for (;;) {
      const inFlight: BriefDeliveryInFlight | undefined =
        this.#deliveriesInFlight.get(targetProviderSessionId);
      if (inFlight === undefined) {
        break;
      }
      if (inFlight.briefIdentityKey === rendering.briefIdentityKey) {
        return await inFlight.settlement;
      }
      // Awaited for completion only; this call derives its own settlement from the target.
      await inFlight.settlement.then(
        () => undefined,
        () => undefined,
      );
      // The target may have been released while this call waited.
      this.#assertOwnedTarget(request.target);
    }

    const flight: Promise<BriefDeliverySettlement> = this.#reconcileThenSend(request, rendering);
    this.#deliveriesInFlight.set(targetProviderSessionId, {
      briefIdentityKey: rendering.briefIdentityKey,
      settlement: flight,
    });
    try {
      return await flight;
    } finally {
      // Cleared however the flight ended. The unconfirmed register is kept on purpose: an ambiguous
      // send outlives its call.
      this.#deliveriesInFlight.delete(targetProviderSessionId);
      // Released mid-flight: drop what the flight recorded after the release.
      if (this.#establishedTargets.get(targetProviderSessionId) !== request.target) {
        this.#dropTargetRegisters(targetProviderSessionId);
      }
    }
  }

  #assertOwnedTarget(target: EstablishedBriefTarget): void {
    if (this.#establishedTargets.get(target.providerSessionId) !== target) {
      throw new UnownedBriefTargetError(target.providerSessionId);
    }
  }

  #dropTargetRegisters(providerSessionId: string): void {
    this.#unconfirmedDeliveries.delete(providerSessionId);
    this.#attemptedBriefIdentityKeysByTarget.delete(providerSessionId);
  }

  async #reconcileThenSend(
    request: BriefDeliveryRequest,
    rendering: BriefRendering,
  ): Promise<BriefDeliverySettlement> {
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
    } catch (readFailure) {
      // Unreadable: nothing is sent, since a duplicate corrupts the conversation and a missing
      // brief only degrades it. With a send outstanding the honest arm is unconfirmed, not
      // withheld.
      return priorSendUnconfirmed
        ? settle(rendering, "unconfirmed", undefined, thisDeliveryLosses(rendering), readFailure)
        : settle(
            rendering,
            "withheld",
            "target-unreadable",
            thisDeliveryLosses(rendering),
            readFailure,
          );
    }

    const attributableBriefIdentityKeys: Set<string> = new Set<string>(
      this.#attemptedBriefIdentityKeysByTarget.get(request.target.providerSessionId),
    );
    attributableBriefIdentityKeys.add(rendering.briefIdentityKey);
    if (targetTurnsCarryAttributableBriefMarker(priorTurns, attributableBriefIdentityKeys)) {
      // The one evidence needing no barrier: the target is seeded by this brief, an earlier key
      // this coordinator attempted, or an outstanding send now known applied (it is the only sender
      // into an established target). The target leaves the register and nothing more is sent.
      this.#unconfirmedDeliveries.delete(request.target.providerSessionId);
      return settle(
        rendering,
        "already-delivered",
        undefined,
        deliveredBriefLosses(priorTurns, rendering.briefIdentityKey),
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
      this.#attemptedBriefIdentityKeysByTarget.get(request.target.providerSessionId);
    if (attemptedKeysForTarget === undefined) {
      attemptedKeysForTarget = new Set<string>();
      this.#attemptedBriefIdentityKeysByTarget.set(
        request.target.providerSessionId,
        attemptedKeysForTarget,
      );
    }
    attemptedKeysForTarget.add(rendering.briefIdentityKey);
    try {
      await this.#gateway.sendBriefTurn({
        targetProviderSessionId: request.target.providerSessionId,
        briefIdentityKey: rendering.briefIdentityKey,
        frame: this.#frameWriter.compose({
          text: rendering.text,
          origin: "system_narration",
        }),
      });
      return settle(rendering, "delivered", undefined, thisDeliveryLosses(rendering));
    } catch (sendFailure) {
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
        // The send's error explains the ambiguity; the failed readback only leaves it standing.
        return settle(
          rendering,
          "unconfirmed",
          undefined,
          thisDeliveryLosses(rendering),
          sendFailure,
        );
      }
      if (targetTurnsCarryBriefMarker(turnsAfterSend, rendering.briefIdentityKey)) {
        // The brief is visibly there, so the unacknowledged send applied; no ordering is needed.
        this.#unconfirmedDeliveries.delete(request.target.providerSessionId);
        // Losses come from the marker; one with no record is not the brief this call composed, so
        // it takes the conservative arm.
        return settle(
          rendering,
          "delivered",
          undefined,
          deliveredBriefLosses(turnsAfterSend, rendering.briefIdentityKey),
        );
      }
      // One absent snapshot while the provider may still be applying is not evidence.
      return settle(
        rendering,
        "unconfirmed",
        undefined,
        thisDeliveryLosses(rendering),
        sendFailure,
      );
    }
  }
}

/**
 * Awaits the caller's barrier; true means a readback taken next is definitive. An absent and a
 * rejected barrier both give false, since a bounded wait expiring is the ordinary unanswered case.
 */
async function awaitSendSettlement(request: BriefDeliveryRequest): Promise<boolean> {
  const barrier: BriefSendSettlementBarrier | undefined = request.sendSettlementBarrier;
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

interface BriefDeliveryInFlight {
  readonly briefIdentityKey: string;
  readonly settlement: Promise<BriefDeliverySettlement>;
}

function settle(
  rendering: BriefRendering,
  disposition: BriefDeliveryDisposition,
  withheldReason: BriefWithheldReason | undefined,
  lossRecord: BriefDeclaredLossRecord,
  cause?: unknown,
): BriefDeliverySettlement {
  return {
    status: "degraded",
    disposition,
    briefIdentityKey: rendering.briefIdentityKey,
    declaredLosses: lossRecord.losses,
    declaredLossSource: lossRecord.source,
    withheldReason,
    rendering,
    ...(cause === undefined ? {} : { cause }),
  };
}

interface BriefDeclaredLossRecord {
  readonly source: BriefDeclaredLossSource;
  readonly losses: readonly DeclaredLossKind[];
}

function thisDeliveryLosses(rendering: BriefRendering): BriefDeclaredLossRecord {
  return { source: "this-delivery", losses: rendering.declaredLosses };
}

/**
 * Losses recorded by the brief the target holds, for settlements resting on a read marker. Only
 * when every occurrence is a readable record of this brief; otherwise the whole closed vocabulary,
 * as an unparsed marker may hold kinds a newer peer daemon wrote, and understating misleads.
 */
function deliveredBriefLosses(
  targetTurns: readonly string[],
  briefIdentityKey: string,
): BriefDeclaredLossRecord {
  const occurrences: readonly BriefContinuityMarkerOccurrence[] =
    readAnyBriefContinuityMarkerOccurrences(targetTurns);
  const recorded: Set<DeclaredLossKind> = new Set<DeclaredLossKind>();
  for (const occurrence of occurrences) {
    if (occurrence.form !== "recorded" || occurrence.briefIdentityKey !== briefIdentityKey) {
      return { source: "unknown", losses: DECLARED_LOSS_KINDS };
    }
    for (const kind of occurrence.kinds) {
      recorded.add(kind);
    }
  }
  return occurrences.length === 0
    ? { source: "unknown", losses: DECLARED_LOSS_KINDS }
    : { source: "delivered-brief", losses: [...recorded] };
}
