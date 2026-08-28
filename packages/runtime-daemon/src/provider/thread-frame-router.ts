// Thread-frame router (Plan-005 Phase 3, T3.11 — the NS-91 child-routing leg).
//
// Both pinned providers multiplex CHILD-THREAD traffic — subagent, review, and
// compaction threads the provider spawns for itself — over the same connection
// that carries the session's own thread. A normalizer that projects every
// frame it receives renders a child's assistant output and tool activity into
// the parent's timeline as though the parent produced them — a fabricated
// transcript — and it either double-counts or loses the child's spend. This
// module owns the thread-identity registry and the fail-closed routing /
// quarantine decision both normalizers consult BEFORE any projection decision,
// and it enforces I-005-12: only the session's own thread projects, and no
// child's spend or interactive request is lost.
//
// The rule, per `Spec-005 §Required Behavior` (2026-08-28, PR #377 round-1
// fold), is FAMILY-SCOPED:
//
//   - A THREAD-SCOPED family routes by explicit thread identity read from the
//     frame; only the session's own thread projects.
//   - A censused CONNECTION- OR ACCOUNT-SCOPED family (Claude
//     `system/api_retry` → `usage.api_retry`, `rate_limits` →
//     `usage.rate_limit_update`, the capability/initialization frames) routes
//     to its registered normalization WITHOUT a thread identity — demanding a
//     member the frame's own shape excludes would quarantine every
//     account-plane signal the corpus already consumes.
//   - An UNRECOGNIZED family is quarantined regardless: the census is the
//     discriminator, and an unlisted shape is never presumed connection-scoped.
//
// Thread identities enter the recognized set on a REGISTRATION PATH ahead of
// the refusal rule: the session's own thread at establishment, and a child
// identity from the provider's parent-linked announcement (the Codex
// `thread/started` notification carrying `parentThreadId` with a subagent
// `ThreadSourceKind`; the Claude `SubagentStart` signal arriving in the
// parent's own stream with `parent_tool_use_id`) — recognition derives from
// the provider's declared lineage, never from arrival order.
//
// Two distinct bounded held states:
//
//   - PENDING-REGISTRATION HOLD: a frame naming a PRESENT-but-unregistered
//     thread — child traffic racing its own announcement — held, released
//     into ordinary routing when the registration lands, shed with a recorded
//     diagnostic on a declared timeout.
//   - QUARANTINE: a frame whose identity is ABSENT where its family requires
//     one, or names a thread no registration path admits — a bounded
//     diagnostic buffer (declared cap, oldest-first shedding, each admission
//     and each shed a `DriverDiagnosticRecord`), NOT a delivery queue, and
//     distinct in semantics from the pending hold.
//
// Two carve-outs apply AHEAD of suppression:
//
//   - USAGE: child spend is metered even though child content is not.
//     Provider-attributed subagent spend rides the (`runId`, `provider`,
//     `subagentId`) triple; spend on a provider-internal child with no
//     subagent identity (a compaction or memory-consolidation thread)
//     attributes to the PARENT RUN at run scope. Neither arm invents a
//     subagent and neither drops a token.
//   - INTERACTIVE REQUESTS: a child's tool-approval / permission / input
//     requests route through the SAME dispatch and approval pipeline as the
//     parent run's, answered on the child's own correlation identity —
//     mandatory per `Spec-016 §Provider-Native Subagents` ("subagent tool
//     calls flow through the same approval pipeline as the parent run's; a
//     subagent introduces no separate trust surface"); suppressing the
//     request with the transcript would not hide the child but HANG it.
//
// What suppression governs is the child's TRANSCRIPT PROJECTION alone. Child
// lifecycle reaches the timeline only through the already-registered
// `subagent.started` / `subagent.completed` kinds (emitted by the consumer at
// registration / completion); a child thread's own frames are never a second
// lifecycle channel.
//
// Verifies invariant: I-005-12 (Plan-005 §Invariants). The single routing
// decision both normalizers consult; consumed unchanged by T3.14's
// terminal-emission boundary, which adds no second routing decision.
//
// Refs: Plan-005 §Phase 3 / T3.11, `Spec-005 §Required Behavior`,
// `Spec-016 §Provider-Native Subagents`.

import { type DriverDiagnosticsEmitter, type DriverProviderName } from "./driver-diagnostics.js";

// --------------------------------------------------------------------------
// Family classification — supplied by the driver's own census knowledge.
// --------------------------------------------------------------------------

/**
 * The capability a thread-scoped frame carries, which selects its carve-out:
 * `usage` and `interactive-request` are carved out ahead of suppression;
 * `lifecycle` and `content` from a child are transcript-suppressed (child
 * lifecycle reaches the timeline only through `subagent.*`, never through the
 * child's own frames).
 */
export type ThreadScopedFrameCapability = "usage" | "interactive-request" | "lifecycle" | "content";

/**
 * One frame's family classification against the pinned stream-surface census.
 * The DRIVER classifies (each normalizer owns its provider's census); the
 * router decides. `unknown` is a real arm: an unlisted family is never
 * presumed connection-scoped.
 */
export type ThreadFrameFamilyClass =
  | { readonly scope: "connection" }
  | { readonly scope: "thread"; readonly capability: ThreadScopedFrameCapability }
  | { readonly scope: "unknown" };

/** One inbound frame as the router sees it. */
export interface RoutableProviderFrame {
  /** The frame's wire kind, verbatim and untrusted; carried as data only. */
  readonly rawWireType: string;
  readonly familyClass: ThreadFrameFamilyClass;
  /** The explicit thread identity read from the frame, or `null` when absent. */
  readonly threadId: string | null;
}

// --------------------------------------------------------------------------
// Registration.
// --------------------------------------------------------------------------

/** How a registered child's usage attributes (`Spec-005 §Required Behavior`). */
export type ChildSpendAttribution =
  | { readonly kind: "subagent"; readonly subagentId: string }
  | { readonly kind: "parent-run" };

/** A provider parent-linked child announcement, as the driver read it. */
export interface ChildThreadAnnouncement {
  readonly childThreadId: string;
  /** The parent linkage the provider itself declared, or `null` if it named none. */
  readonly declaredParentThreadId: string | null;
  /**
   * The provider-attributed subagent identity, where the announcement carries
   * one (a Codex subagent `ThreadSourceKind` item, a Claude `SubagentStart`
   * `parent_tool_use_id` pairing); `null` for a provider-internal child (a
   * compaction or memory-consolidation thread), whose spend attributes to the
   * parent run at run scope.
   */
  readonly subagentId: string | null;
}

/** The result of admitting one child announcement. */
export type ChildRegistrationResult =
  | {
      readonly registered: true;
      readonly childThreadId: string;
      readonly attribution: ChildSpendAttribution;
      /** Frames held pending this registration, released in arrival order. */
      readonly releasedFrames: readonly RoutableProviderFrame[];
    }
  | { readonly registered: false; readonly reason: string };

// --------------------------------------------------------------------------
// The routing decision.
// --------------------------------------------------------------------------

export type ThreadFrameRoute =
  /** The session's own thread: project into the session timeline. */
  | { readonly decision: "project" }
  /** A censused connection- or account-scoped family: route without identity. */
  | { readonly decision: "route-connection-scoped" }
  /** A registered child's usage frame: meter under the stated attribution. */
  | {
      readonly decision: "carve-out-usage";
      readonly childThreadId: string;
      readonly attribution: ChildSpendAttribution;
    }
  /**
   * A registered child's interactive request: route through the same dispatch
   * and approval pipeline as the parent run's, answer on the child's own
   * correlation identity.
   */
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

// --------------------------------------------------------------------------
// The router.
// --------------------------------------------------------------------------

export interface ThreadFrameRouterConfig {
  readonly maxQuarantinedFrames: number;
  readonly maxPendingHoldFrames: number;
  readonly pendingRegistrationTimeoutMs: number;
}

export class ThreadFrameRouter {
  readonly #provider: DriverProviderName;
  readonly #diagnostics: DriverDiagnosticsEmitter;
  readonly #config: ThreadFrameRouterConfig;

  #sessionThreadId: string | null = null;
  readonly #childAttributionsByThreadId = new Map<string, ChildSpendAttribution>();
  readonly #suppressionDiagnosedChildThreadIds = new Set<string>();
  readonly #pendingHolds: {
    readonly frame: RoutableProviderFrame;
    readonly heldAtMs: number;
  }[] = [];
  readonly #quarantinedFrames: RoutableProviderFrame[] = [];

  constructor(options: {
    readonly provider: DriverProviderName;
    readonly diagnostics: DriverDiagnosticsEmitter;
    readonly config: ThreadFrameRouterConfig;
  }) {
    this.#provider = options.provider;
    this.#diagnostics = options.diagnostics;
    this.#config = options.config;
  }

  /** Register the session's own thread at establishment. */
  registerSessionThread(threadId: string): void {
    this.#sessionThreadId = threadId;
  }

  /**
   * Admit a provider parent-linked child announcement.
   *
   * Registration derives from the provider's DECLARED lineage: an
   * announcement whose parent linkage names no recognized thread — neither
   * the session's own nor an already-registered child — does not register,
   * and the refusal is a recorded diagnostic rather than a silent ignore.
   * A successful registration releases every frame held pending it, in
   * arrival order, for ordinary re-routing by the caller.
   */
  registerChildThread(announcement: ChildThreadAnnouncement): ChildRegistrationResult {
    const parentRecognized =
      announcement.declaredParentThreadId !== null &&
      (announcement.declaredParentThreadId === this.#sessionThreadId ||
        this.#childAttributionsByThreadId.has(announcement.declaredParentThreadId));

    if (!parentRecognized) {
      const reason =
        "child announcement carries no recognized parent linkage; recognition derives from declared lineage, never arrival order (Spec-005 §Required Behavior)";
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

    const releasedFrames: RoutableProviderFrame[] = [];
    for (let index = 0; index < this.#pendingHolds.length; ) {
      const held = this.#pendingHolds[index];
      if (held !== undefined && held.frame.threadId === announcement.childThreadId) {
        this.#pendingHolds.splice(index, 1);
        releasedFrames.push(held.frame);
      } else {
        index += 1;
      }
    }

    return {
      registered: true,
      childThreadId: announcement.childThreadId,
      attribution,
      releasedFrames,
    };
  }

  /**
   * Route one inbound frame. The single decision both normalizers consult
   * before any projection; T3.14's emission boundary consumes it unchanged.
   */
  routeFrame(frame: RoutableProviderFrame, nowMs: number): ThreadFrameRoute {
    this.expirePendingHolds(nowMs);

    if (frame.familyClass.scope === "connection") {
      return { decision: "route-connection-scoped" };
    }

    if (frame.familyClass.scope === "unknown") {
      return this.#quarantine(
        frame,
        "unrecognized family; the pinned census is the discriminator and an unlisted shape is never presumed connection-scoped",
      );
    }

    if (frame.threadId === null) {
      return this.#quarantine(
        frame,
        "thread-scoped family carrying no thread identity; fail-closed per Spec-005 §Required Behavior",
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
      // Content and the child's own lifecycle frames: transcript-suppressed.
      // Diagnosed once per child thread so content deltas do not flood the
      // channel; the pair `subagent.started` / `subagent.completed` remains
      // the child's only timeline presence.
      if (!this.#suppressionDiagnosedChildThreadIds.has(frame.threadId)) {
        this.#suppressionDiagnosedChildThreadIds.add(frame.threadId);
        this.#diagnostics.emit({
          provider: this.#provider,
          kind: "thread_child_transcript_suppressed",
          rawWireType: frame.rawWireType,
          dispositionReason:
            "registered child thread's transcript projection suppressed; child lifecycle reaches the timeline only as subagent.started / subagent.completed",
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
            "pending-registration hold exceeded its declared cap; oldest entry shed per the bounded-hold rule",
          details: {
            threadId: shedHold.frame.threadId,
            maxPendingHoldFrames: this.#config.maxPendingHoldFrames,
          },
        });
      }
    }
    return { decision: "held-pending-registration" };
  }

  /**
   * Shed pending holds whose registration never landed inside the declared
   * timeout — each shed a recorded diagnostic, never a silent drop.
   */
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
            "pending-registration hold timed out before the parent-linked announcement landed; shed with a recorded diagnostic",
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

  /** Frames currently held pending registration (oldest first). */
  pendingHeldFrameCount(): number {
    return this.#pendingHolds.length;
  }

  /** Frames currently retained in the quarantine buffer (oldest first). */
  quarantinedFrames(): readonly RoutableProviderFrame[] {
    return [...this.#quarantinedFrames];
  }

  #quarantine(frame: RoutableProviderFrame, reason: string): ThreadFrameRoute {
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
            "quarantine buffer exceeded its declared cap; oldest entry shed (a diagnostic buffer, not a delivery queue)",
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
