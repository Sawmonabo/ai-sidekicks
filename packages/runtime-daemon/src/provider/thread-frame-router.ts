// Thread-frame router: decides which inbound provider frames project into the session transcript.
//
// Both providers multiplex child-thread traffic (subagent, review and compaction threads) over
// the connection that carries the session's own thread. Projecting every frame would render a
// child's output in the parent's transcript and double-count or lose the child's spend. Each
// session's lifecycle module owns one router and routes every inbound frame through it before
// normalizing. Only the session's own thread projects.
//
// Routing is by family:
// - A thread-scoped family routes by the explicit thread identity on the frame.
// - A connection- or account-scoped family (retry notices, rate limits, the capability and
//   initialization frames) routes without a thread identity, because its shape has none.
// - An unrecognized family is quarantined; an unlisted shape is never presumed connection-scoped.
//
// A thread identity is recognized by registration: the session's own thread at establishment, or
// a child announced with a provider-declared parent (each driver reads the parent linkage off its
// own child-start frame). It is never inferred from arrival order.
//
// Two bounded held states differ in meaning:
// - Pending-registration hold: a frame naming a thread that is present but unregistered (child
//   traffic racing its announcement). It is released when the registration lands and shed
//   with a diagnostic on timeout.
// - Quarantine: a frame with no identity where its family needs one, or naming a thread no
//   registration admits. It is a capped diagnostic buffer, oldest shed first, not a delivery
//   queue.
//
// Two carve-outs apply ahead of suppression:
// - Usage: child spend is metered even though child content is not. Subagent spend rides the
//   (`runId`, `provider`, `subagentId`) triple; spend on an internal child with no subagent
//   identity (compaction, memory consolidation) attributes to the parent run.
// - Interactive requests: a child's approval, permission and input requests use the parent run's
//   dispatch and approval pipeline, answered on the child's own correlation identity. Suppressing
//   them would hang the child.
//
// Suppression covers only a child's transcript projection. Child lifecycle reaches the transcript
// through `subagent.started` and `subagent.completed`, never through the child's own frames.
// The terminal-emission gate consumes the route unchanged.

import type { ProviderName } from "@ai-sidekicks/contracts/provider/account/account";

import { type DriverDiagnosticsEmitter } from "./driver/diagnostics.js";

/**
 * The capability a thread-scoped frame carries, which selects its carve-out: `usage` and
 * `interactive-request` are carved out ahead of suppression, while `lifecycle` and `content`
 * from a child are transcript-suppressed.
 */
type ThreadScopedFrameCapability = "usage" | "interactive-request" | "lifecycle" | "content";

/**
 * One frame's family against the pinned stream-surface census. The driver classifies and the
 * router decides. `unknown` is a real arm because an unlisted family is never presumed
 * connection-scoped.
 */
export type ThreadFrameFamilyClass =
  | { readonly scope: "connection" }
  | { readonly scope: "thread"; readonly capability: ThreadScopedFrameCapability }
  | { readonly scope: "unknown" };

/**
 * One inbound frame as the router sees it. The router reads only what this interface declares,
 * so each driver's frame type states how it derives `threadId` from its own wire.
 */
export interface RoutableProviderFrame {
  /** The frame's wire kind, verbatim and untrusted; carried as data only. */
  readonly rawWireType: string;
  readonly familyClass: ThreadFrameFamilyClass;
  /** The explicit thread identity read from the frame, or `null` when absent. */
  readonly threadId: string | null;
}

/** How a registered child's usage attributes: to its subagent, or to the parent run. */
export type ChildSpendAttribution =
  | { readonly kind: "subagent"; readonly subagentId: string }
  | { readonly kind: "parent-run" };

/** A provider parent-linked child announcement, as the driver read it. */
export interface ChildThreadAnnouncement {
  readonly childThreadId: string;
  /** The parent linkage the provider itself declared, or `null` if it named none. */
  readonly declaredParentThreadId: string | null;
  /**
   * The provider-attributed subagent identity, or `null` for an internal child such as a
   * compaction thread, whose spend attributes to the parent run.
   */
  readonly subagentId: string | null;
}

/** The result of admitting one child announcement. */
export type ChildRegistrationResult<TFrame extends RoutableProviderFrame = RoutableProviderFrame> =
  | {
      readonly registered: true;
      readonly childThreadId: string;
      readonly attribution: ChildSpendAttribution;
      /** Frames held pending this registration, released in arrival order. */
      readonly releasedFrames: readonly TFrame[];
    }
  | { readonly registered: false; readonly reason: string };

/**
 * The result of releasing a completed child thread's router state. A child that never registered
 * can still have pending holds naming it; they are returned so the caller sheds them with a
 * diagnostic instead of dropping them silently.
 */
export interface ChildCompletionResult<
  TFrame extends RoutableProviderFrame = RoutableProviderFrame,
> {
  /** `true` when the child was registered at completion time. */
  readonly wasRegistered: boolean;
  /** Frames still held pending this child's registration when it completed. */
  readonly abandonedPendingFrames: readonly TFrame[];
}

/**
 * A `subagent.started` or `subagent.completed` emission a driver states when a child registers
 * or completes; the emission pipeline mints the `tool_activity` envelope. These two are the
 * child's only transcript presence, since its own frames are transcript-suppressed.
 */
export interface SubagentLifecycleEmission {
  readonly eventType: "subagent.started" | "subagent.completed";
  /** The provider-attributed subagent identity, verbatim off the wire. */
  readonly subagentId: string;
  /**
   * The provider's own parent linkage, verbatim, or `null` where the announcement named none.
   */
  readonly parentReference: string | null;
}

/** The single routing decision for one frame, consumed unchanged by the emission gate. */
export type ThreadFrameRoute =
  /** The session's own thread: project into the session transcript. */
  | { readonly decision: "project" }
  /** A known connection- or account-scoped family: route without identity. */
  | { readonly decision: "route-connection-scoped" }
  /** A registered child's usage frame: meter under the stated attribution. */
  | {
      readonly decision: "carve-out-usage";
      readonly childThreadId: string;
      readonly attribution: ChildSpendAttribution;
    }
  /** A registered child's interactive request: same pipeline as the parent's, child's identity. */
  | {
      readonly decision: "carve-out-interactive-request";
      readonly childThreadId: string;
    }
  /** A registered child's content or lifecycle frame: transcript-suppressed. */
  | { readonly decision: "suppress-child-transcript"; readonly childThreadId: string }
  /** Present-but-unregistered identity: held awaiting its announcement. */
  | { readonly decision: "held-pending-registration" }
  /** Absent or unrecognized identity, or unrecognized family: refused. */
  | { readonly decision: "quarantined"; readonly reason: string };

/** The caps and timeout that bound the router's two held states. */
export interface ThreadFrameRouterConfig {
  readonly maxQuarantinedFrames: number;
  readonly maxPendingHoldFrames: number;
  readonly pendingRegistrationTimeoutMs: number;
}

/** Holds the thread registry for one session and makes the routing decision for each frame. */
export class ThreadFrameRouter<TFrame extends RoutableProviderFrame = RoutableProviderFrame> {
  readonly #provider: ProviderName;
  readonly #diagnostics: DriverDiagnosticsEmitter;
  readonly #config: ThreadFrameRouterConfig;

  #sessionThreadId: string | null = null;
  readonly #childAttributionsByThreadId = new Map<string, ChildSpendAttribution>();
  readonly #suppressionDiagnosedChildThreadIds = new Set<string>();
  readonly #pendingHolds: {
    readonly frame: TFrame;
    readonly heldAtMs: number;
  }[] = [];
  readonly #quarantinedFrames: TFrame[] = [];

  constructor(options: {
    readonly provider: ProviderName;
    readonly diagnostics: DriverDiagnosticsEmitter;
    readonly config: ThreadFrameRouterConfig;
  }) {
    this.#provider = options.provider;
    this.#diagnostics = options.diagnostics;
    this.#config = options.config;
  }

  /**
   * Registers the session's own thread at establishment and returns the frames held pending it.
   * Session traffic can arrive before the identity is known (a provider may announce its thread
   * id while frames are in flight), so the caller must re-route the returned frames; discarding
   * them sheds session traffic unrecoverably.
   */
  registerSessionThread(threadId: string): readonly TFrame[] {
    this.#sessionThreadId = threadId;
    return this.#takePendingHoldsFor(threadId);
  }

  /**
   * Admits a provider parent-linked child announcement. An announcement whose parent is neither
   * the session's own thread nor a registered child is refused with a diagnostic. On success it
   * returns the frames held pending the child, in arrival order, for the caller to re-route.
   */
  registerChildThread(announcement: ChildThreadAnnouncement): ChildRegistrationResult<TFrame> {
    const parentRecognized =
      announcement.declaredParentThreadId !== null &&
      (announcement.declaredParentThreadId === this.#sessionThreadId ||
        this.#childAttributionsByThreadId.has(announcement.declaredParentThreadId));

    if (!parentRecognized) {
      const reason =
        "child announcement carries no recognized parent linkage; recognition derives from " +
        "the provider's declared lineage, never from arrival order";
      this.#diagnostics.emit({
        provider: this.#provider,
        kind: "thread_registration_refused",
        rawWireType: null,
        dispositionReason: reason,
        details: {
          childThreadId: announcement.childThreadId,
          declaredParentThreadId: announcement.declaredParentThreadId,
        },
      });
      return { registered: false, reason };
    }

    const attribution: ChildSpendAttribution =
      announcement.subagentId === null
        ? { kind: "parent-run" }
        : { kind: "subagent", subagentId: announcement.subagentId };
    this.#childAttributionsByThreadId.set(announcement.childThreadId, attribution);

    return {
      registered: true,
      childThreadId: announcement.childThreadId,
      attribution,
      releasedFrames: this.#takePendingHoldsFor(announcement.childThreadId),
    };
  }

  /** The registered attribution for one child thread, or `undefined`. */
  childAttributionFor(childThreadId: string): ChildSpendAttribution | undefined {
    return this.#childAttributionsByThreadId.get(childThreadId);
  }

  /**
   * Releases a completed child thread's state so the attribution map and the
   * suppression-diagnosed set do not grow with every child a long session spawns. Call it from the
   * driver's child-terminal path. Completion is terminal for the identity: a later frame naming it
   * is pending-unregistered again and ends in the timeout shed.
   */
  completeChildThread(childThreadId: string): ChildCompletionResult<TFrame> {
    const wasRegistered = this.#childAttributionsByThreadId.delete(childThreadId);
    this.#suppressionDiagnosedChildThreadIds.delete(childThreadId);

    const abandonedPendingFrames = this.#takePendingHoldsFor(childThreadId);
    for (const abandonedFrame of abandonedPendingFrames) {
      this.#diagnostics.emit({
        provider: this.#provider,
        kind: "thread_pending_hold_shed",
        rawWireType: abandonedFrame.rawWireType,
        dispositionReason:
          "child thread completed while frames were still held pending its registration; " +
          "shed with a recorded diagnostic rather than dropped",
        details: { threadId: abandonedFrame.threadId, childThreadId },
      });
    }

    return { wasRegistered, abandonedPendingFrames };
  }

  /** Removes and returns the holds naming `threadId` in arrival order; the one release path. */
  #takePendingHoldsFor(threadId: string): readonly TFrame[] {
    const releasedFrames: TFrame[] = [];
    for (let index = 0; index < this.#pendingHolds.length; ) {
      const held = this.#pendingHolds[index];
      if (held !== undefined && held.frame.threadId === threadId) {
        this.#pendingHolds.splice(index, 1);
        releasedFrames.push(held.frame);
      } else {
        index += 1;
      }
    }
    return releasedFrames;
  }

  /** Routes one inbound frame; the single decision both normalizers consult before projecting. */
  routeFrame(frame: TFrame, nowMs: number): ThreadFrameRoute {
    this.expirePendingHolds(nowMs);

    if (frame.familyClass.scope === "connection") {
      return { decision: "route-connection-scoped" };
    }

    if (frame.familyClass.scope === "unknown") {
      return this.#quarantine(
        frame,
        "unrecognized family; the pinned census is the discriminator and an unlisted shape " +
          "is never presumed connection-scoped",
      );
    }

    if (frame.threadId === null) {
      return this.#quarantine(
        frame,
        "thread-scoped frame family carrying no thread identity; refused fail-closed rather " +
          "than projected into the session's own thread",
      );
    }

    if (frame.threadId === this.#sessionThreadId) {
      return { decision: "project" };
    }

    const childAttribution = this.#childAttributionsByThreadId.get(frame.threadId);
    if (childAttribution !== undefined) {
      if (frame.familyClass.capability === "usage") {
        return {
          decision: "carve-out-usage",
          childThreadId: frame.threadId,
          attribution: childAttribution,
        };
      }
      if (frame.familyClass.capability === "interactive-request") {
        return { decision: "carve-out-interactive-request", childThreadId: frame.threadId };
      }
      // Content and lifecycle frames are suppressed; diagnose once per child so deltas do not
      // flood the channel.
      if (!this.#suppressionDiagnosedChildThreadIds.has(frame.threadId)) {
        this.#suppressionDiagnosedChildThreadIds.add(frame.threadId);
        this.#diagnostics.emit({
          provider: this.#provider,
          kind: "thread_child_transcript_suppressed",
          rawWireType: frame.rawWireType,
          dispositionReason:
            "registered child thread's transcript projection suppressed; child lifecycle " +
            "reaches the transcript only as subagent.started / subagent.completed",
          details: { childThreadId: frame.threadId },
        });
      }
      return { decision: "suppress-child-transcript", childThreadId: frame.threadId };
    }

    // Present-but-unregistered: child traffic racing its own announcement.
    this.#pendingHolds.push({ frame, heldAtMs: nowMs });
    if (this.#pendingHolds.length > this.#config.maxPendingHoldFrames) {
      const shedHold = this.#pendingHolds.shift();
      if (shedHold !== undefined) {
        this.#diagnostics.emit({
          provider: this.#provider,
          kind: "thread_pending_hold_shed",
          rawWireType: shedHold.frame.rawWireType,
          dispositionReason:
            "pending-registration hold exceeded its declared cap; oldest entry shed per the " +
            "bounded-hold rule",
          details: {
            threadId: shedHold.frame.threadId,
            maxPendingHoldFrames: this.#config.maxPendingHoldFrames,
          },
        });
      }
    }
    return { decision: "held-pending-registration" };
  }

  /** Sheds pending holds older than the timeout, each with a diagnostic. */
  expirePendingHolds(nowMs: number): void {
    for (let index = 0; index < this.#pendingHolds.length; ) {
      const held = this.#pendingHolds[index];
      if (
        held !== undefined &&
        nowMs - held.heldAtMs >= this.#config.pendingRegistrationTimeoutMs
      ) {
        this.#pendingHolds.splice(index, 1);
        this.#diagnostics.emit({
          provider: this.#provider,
          kind: "thread_pending_hold_shed",
          rawWireType: held.frame.rawWireType,
          dispositionReason:
            "pending-registration hold timed out before the parent-linked announcement " +
            "landed; shed with a recorded diagnostic",
          details: {
            threadId: held.frame.threadId,
            heldForMs: nowMs - held.heldAtMs,
            pendingRegistrationTimeoutMs: this.#config.pendingRegistrationTimeoutMs,
          },
        });
      } else {
        index += 1;
      }
    }
  }

  /** How many frames are currently held pending registration. */
  pendingHeldFrameCount(): number {
    return this.#pendingHolds.length;
  }

  #quarantine(frame: TFrame, reason: string): ThreadFrameRoute {
    this.#quarantinedFrames.push(frame);
    this.#diagnostics.emit({
      provider: this.#provider,
      kind: "thread_frame_quarantined",
      rawWireType: frame.rawWireType,
      dispositionReason: reason,
      details: { threadId: frame.threadId },
    });
    if (this.#quarantinedFrames.length > this.#config.maxQuarantinedFrames) {
      const shedFrame = this.#quarantinedFrames.shift();
      if (shedFrame !== undefined) {
        this.#diagnostics.emit({
          provider: this.#provider,
          kind: "thread_quarantine_shed",
          rawWireType: shedFrame.rawWireType,
          dispositionReason:
            "quarantine buffer exceeded its declared cap; oldest entry shed (a diagnostic " +
            "buffer, not a delivery queue)",
          details: {
            threadId: shedFrame.threadId,
            maxQuarantinedFrames: this.#config.maxQuarantinedFrames,
          },
        });
      }
    }
    return { decision: "quarantined", reason };
  }
}
