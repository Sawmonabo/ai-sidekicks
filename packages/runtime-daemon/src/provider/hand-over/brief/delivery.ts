/**
 * Delivers a rendered brief to a target once, and settles the outcome: the outbound frame, the
 * target gateway, and the coordinator that keeps a target to one brief send.
 */

import type { DeclaredLossKind } from "@ai-sidekicks/contracts/provider/driver/transcript";
import type { OutboundTextFrame } from "../../outbound-frame.js";
import { OutboundTextFrameWriter } from "../../outbound-frame.js";
import {
  EstablishedBriefTarget,
  type BriefBudgetPolicy,
  BriefProjection,
  type BriefRendering,
  type BriefTargetIdentity,
  UnownedBriefTargetError,
} from "./brief.js";
import type { CanonicalTranscriptProjection } from "../../driver/provider-driver.js";

/**
 * The frame handed to the gateway, minted `system_narration`; the driver owns encoding. A frame,
 * not a string, so a gateway cannot send bytes that skipped neutralization and correlation minting.
 */
export interface BriefOutboundFrame {
  readonly targetProviderSessionId: string;
  readonly frame: OutboundTextFrame;
}

/** The target as this floor sees it: the one send. */
export interface BriefTargetGateway {
  /** Delivers the brief turn. A rejection is uncertain: the frame may have been applied. */
  sendBriefTurn(frame: BriefOutboundFrame): Promise<void>;
}

/** One delivery: the projection, the established target and the budget. */
export interface BriefDeliveryRequest {
  readonly projection: CanonicalTranscriptProjection;
  /** An established handle, not a bare identity: only its minting coordinator may deliver. */
  readonly target: EstablishedBriefTarget;
  readonly budget: BriefBudgetPolicy;
}

/**
 * `delivered` means the target acknowledged the brief; `unconfirmed` means the send failed and may
 * or may not have landed, so the switch fails and nothing is sent into that target again.
 */
type BriefDeliveryDisposition = "delivered" | "unconfirmed";

/** The outcome of one delivery: its disposition, the declared losses, and the rendering. */
export interface BriefDeliverySettlement {
  /** Always `degraded`: `applied` would tell the user the model sees the conversation. */
  readonly status: "degraded";
  readonly disposition: BriefDeliveryDisposition;
  readonly declaredLosses: readonly DeclaredLossKind[];
  /** What was rendered, whether or not it landed. Held in memory only. */
  readonly rendering: BriefRendering;
  /** The gateway error behind an unconfirmed send. */
  readonly cause?: unknown;
}

/**
 * Sends at most one brief into each established target and settles it. Every later delivery into
 * that target, overlapping or not, gets the first one's settlement and sends nothing. The record is
 * in memory, per coordinator, and released with the target.
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
  /** The one delivery into each target id, settled or in flight. */
  readonly #deliveries: Map<string, Promise<BriefDeliverySettlement>> = new Map<
    string,
    Promise<BriefDeliverySettlement>
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
   * coordinator cannot verify; see {@link EstablishedBriefTarget}). Idempotent per provider
   * session.
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
   * Forgets a target whose provider session has ended: its handle stops delivering and its record
   * is dropped. A delivery in flight still settles for its caller.
   */
  releaseTarget(providerSessionId: string): void {
    this.#establishedTargets.delete(providerSessionId);
    this.#deliveries.delete(providerSessionId);
  }

  /** Delivers the brief into the established target at most once and settles what happened. */
  async deliver(request: BriefDeliveryRequest): Promise<BriefDeliverySettlement> {
    // Before anything is rendered or sent. Thrown, not settled, since nothing was attempted.
    const targetProviderSessionId: string = request.target.providerSessionId;
    if (this.#establishedTargets.get(targetProviderSessionId) !== request.target) {
      throw new UnownedBriefTargetError(targetProviderSessionId);
    }
    const earlierDelivery: Promise<BriefDeliverySettlement> | undefined =
      this.#deliveries.get(targetProviderSessionId);
    if (earlierDelivery !== undefined) {
      return await earlierDelivery;
    }
    const rendering: BriefRendering = this.#projection.render({
      projection: request.projection,
      budget: request.budget,
    });
    const delivery: Promise<BriefDeliverySettlement> = this.#send(
      targetProviderSessionId,
      rendering,
    );
    this.#deliveries.set(targetProviderSessionId, delivery);
    return await delivery;
  }

  async #send(
    targetProviderSessionId: string,
    rendering: BriefRendering,
  ): Promise<BriefDeliverySettlement> {
    try {
      await this.#gateway.sendBriefTurn({
        targetProviderSessionId,
        frame: this.#frameWriter.compose({
          text: rendering.text,
          origin: "system_narration",
        }),
      });
      return settle(rendering, "delivered");
    } catch (sendFailure) {
      return settle(rendering, "unconfirmed", sendFailure);
    }
  }
}

function settle(
  rendering: BriefRendering,
  disposition: BriefDeliveryDisposition,
  cause?: unknown,
): BriefDeliverySettlement {
  return {
    status: "degraded",
    disposition,
    declaredLosses: rendering.declaredLosses,
    rendering,
    ...(cause === undefined ? {} : { cause }),
  };
}
