// Thread-frame router suite (Plan-005 T3.11 — the NS-91 child-routing leg).
//
// Spec coverage under test:
//   • `Spec-005 §Required Behavior` — the family-scoped, fail-closed
//     child-frame routing rule: thread-scoped families route by explicit
//     thread identity, censused connection-scoped families route without one,
//     child identities register from the provider's parent-linked
//     announcements, a present-but-unregistered identity is held in a bounded
//     pending-registration buffer, and an absent or unrecognized identity is
//     quarantined — never projected or guessed into the parent.
//   • `Spec-016 §Provider-Native Subagents` — child-raised interactive
//     requests carve through to the same approval pipeline as the parent's;
//     provider-attributed subagent spend rides the subagent identity while
//     provider-internal child spend attributes to the parent run.
//
// Verifies invariant: I-005-12 (no child-thread frame is projected into the
// parent session's timeline or metered into the parent's usage except through
// the registered-carve-out decisions; the `subagent.started` /
// `subagent.completed` pair is the child's only timeline presence).

import { describe, expect, it } from "vitest";

import { DriverDiagnosticsEmitter } from "../driver-diagnostics.js";
import {
  ThreadFrameRouter,
  type RoutableProviderFrame,
  type ThreadFrameRouterConfig,
} from "../thread-frame-router.js";

const routerConfigDefaults: ThreadFrameRouterConfig = {
  maxQuarantinedFrames: 4,
  maxPendingHoldFrames: 4,
  pendingRegistrationTimeoutMs: 1_000,
};

function makeRouter(configOverrides?: Partial<ThreadFrameRouterConfig>) {
  const diagnostics = new DriverDiagnosticsEmitter({ logSink: { record: () => undefined } });
  const router = new ThreadFrameRouter({
    provider: "codex",
    diagnostics,
    config: { ...routerConfigDefaults, ...configOverrides },
  });
  return { router, diagnostics };
}

function usageFrame(
  threadId: string | null,
  rawWireType = "thread/tokenUsage/updated",
): RoutableProviderFrame {
  return { rawWireType, familyClass: { scope: "thread", capability: "usage" }, threadId };
}

describe("ThreadFrameRouter (T3.11, I-005-12)", () => {
  it("censused connection-scoped families route without a thread id (api_retry / rate-limit census pass)", () => {
    const { router, diagnostics } = makeRouter();
    router.registerSessionThread("session-thread");
    for (const connectionScopedKind of ["system/api_retry", "account/rateLimits/updated"]) {
      const route = router.routeFrame(
        { rawWireType: connectionScopedKind, familyClass: { scope: "connection" }, threadId: null },
        0,
      );
      expect(route).toEqual({ decision: "route-connection-scoped" });
    }
    expect(diagnostics.emittedRecordCount()).toBe(0);
  });

  it("the session's own thread projects", () => {
    const { router } = makeRouter();
    router.registerSessionThread("session-thread");
    expect(router.routeFrame(usageFrame("session-thread"), 0)).toEqual({ decision: "project" });
  });

  it("an unknown family quarantines even when a thread id is present — never presumed connection-scoped", () => {
    const { router, diagnostics } = makeRouter();
    router.registerSessionThread("session-thread");
    const route = router.routeFrame(
      {
        rawWireType: "novel/unlisted-shape",
        familyClass: { scope: "unknown" },
        threadId: "session-thread",
      },
      0,
    );
    expect(route.decision).toBe("quarantined");
    expect(diagnostics.recentRecordsOfKind("thread_frame_quarantined")).toHaveLength(1);
  });

  it("a thread-scoped frame with no thread identity quarantines fail-closed", () => {
    const { router, diagnostics } = makeRouter();
    router.registerSessionThread("session-thread");
    const route = router.routeFrame(usageFrame(null), 0);
    expect(route.decision).toBe("quarantined");
    expect(router.quarantinedFrames()).toHaveLength(1);
    expect(diagnostics.recentRecordsOfKind("thread_frame_quarantined")).toHaveLength(1);
  });

  it("the quarantine buffer is bounded: oldest shed first, each shed a diagnostic", () => {
    const { router, diagnostics } = makeRouter({ maxQuarantinedFrames: 2 });
    router.registerSessionThread("session-thread");
    router.routeFrame(usageFrame(null, "bad-frame-0"), 0);
    router.routeFrame(usageFrame(null, "bad-frame-1"), 1);
    router.routeFrame(usageFrame(null, "bad-frame-2"), 2);
    expect(router.quarantinedFrames().map((frame) => frame.rawWireType)).toEqual([
      "bad-frame-1",
      "bad-frame-2",
    ]);
    expect(diagnostics.recentRecordsOfKind("thread_quarantine_shed")).toHaveLength(1);
    expect(diagnostics.recentRecordsOfKind("thread_quarantine_shed")[0]?.rawWireType).toBe(
      "bad-frame-0",
    );
  });

  it("a provider-attributed subagent child's usage carves out under the subagent triple", () => {
    const { router } = makeRouter();
    router.registerSessionThread("session-thread");
    const registration = router.registerChildThread({
      childThreadId: "child-thread",
      declaredParentThreadId: "session-thread",
      subagentId: "child-thread",
    });
    expect(registration.registered).toBe(true);
    expect(router.routeFrame(usageFrame("child-thread"), 0)).toEqual({
      decision: "carve-out-usage",
      childThreadId: "child-thread",
      attribution: { kind: "subagent", subagentId: "child-thread" },
    });
  });

  it("a provider-internal child's usage (compaction thread) attributes to the parent run", () => {
    const { router } = makeRouter();
    router.registerSessionThread("session-thread");
    router.registerChildThread({
      childThreadId: "compaction-thread",
      declaredParentThreadId: "session-thread",
      subagentId: null,
    });
    expect(router.routeFrame(usageFrame("compaction-thread"), 0)).toEqual({
      decision: "carve-out-usage",
      childThreadId: "compaction-thread",
      attribution: { kind: "parent-run" },
    });
  });

  it("a child-raised interactive request carves through to the approval pipeline on the child's own correlation", () => {
    const { router } = makeRouter();
    router.registerSessionThread("session-thread");
    router.registerChildThread({
      childThreadId: "child-thread",
      declaredParentThreadId: "session-thread",
      subagentId: "child-thread",
    });
    const route = router.routeFrame(
      {
        rawWireType: "item/commandExecution/requestApproval",
        familyClass: { scope: "thread", capability: "interactive-request" },
        threadId: "child-thread",
      },
      0,
    );
    expect(route).toEqual({
      decision: "carve-out-interactive-request",
      childThreadId: "child-thread",
    });
  });

  it("a registered child's content and lifecycle frames are transcript-suppressed, diagnosed once per child", () => {
    const { router, diagnostics } = makeRouter();
    router.registerSessionThread("session-thread");
    router.registerChildThread({
      childThreadId: "child-thread",
      declaredParentThreadId: "session-thread",
      subagentId: "child-thread",
    });
    for (let deltaSequence = 0; deltaSequence < 3; deltaSequence += 1) {
      const route = router.routeFrame(
        {
          rawWireType: "item/agentMessage/delta",
          familyClass: { scope: "thread", capability: "content" },
          threadId: "child-thread",
        },
        deltaSequence,
      );
      expect(route).toEqual({
        decision: "suppress-child-transcript",
        childThreadId: "child-thread",
      });
    }
    // Once per child thread — content deltas must not flood the channel.
    expect(diagnostics.recentRecordsOfKind("thread_child_transcript_suppressed")).toHaveLength(1);
  });

  it("a present-but-unregistered identity is held, then released in arrival order on registration", () => {
    const { router } = makeRouter();
    router.registerSessionThread("session-thread");
    const earlyUsageFrame = usageFrame("racing-child", "early-usage");
    const earlyContentFrame: RoutableProviderFrame = {
      rawWireType: "early-content",
      familyClass: { scope: "thread", capability: "content" },
      threadId: "racing-child",
    };
    expect(router.routeFrame(earlyUsageFrame, 0)).toEqual({
      decision: "held-pending-registration",
    });
    expect(router.routeFrame(earlyContentFrame, 1)).toEqual({
      decision: "held-pending-registration",
    });
    expect(router.pendingHeldFrameCount()).toBe(2);

    const registration = router.registerChildThread({
      childThreadId: "racing-child",
      declaredParentThreadId: "session-thread",
      subagentId: "racing-child",
    });
    expect(registration.registered).toBe(true);
    if (registration.registered) {
      expect(registration.releasedFrames.map((frame) => frame.rawWireType)).toEqual([
        "early-usage",
        "early-content",
      ]);
    }
    expect(router.pendingHeldFrameCount()).toBe(0);
    // Released frames re-route ordinarily now that the child is registered.
    expect(router.routeFrame(earlyUsageFrame, 2).decision).toBe("carve-out-usage");
  });

  it("a pending hold that outlives its timeout is shed with a diagnostic — distinct from quarantine", () => {
    const { router, diagnostics } = makeRouter({ pendingRegistrationTimeoutMs: 500 });
    router.registerSessionThread("session-thread");
    router.routeFrame(usageFrame("never-announced"), 0);
    expect(router.pendingHeldFrameCount()).toBe(1);
    router.expirePendingHolds(500);
    expect(router.pendingHeldFrameCount()).toBe(0);
    expect(diagnostics.recentRecordsOfKind("thread_pending_hold_shed")).toHaveLength(1);
    // A shed hold is not a quarantine entry: the two buffers stay distinct.
    expect(router.quarantinedFrames()).toHaveLength(0);
    expect(diagnostics.recentRecordsOfKind("thread_frame_quarantined")).toHaveLength(0);
  });

  it("the pending-hold buffer is bounded: exceeding the cap sheds the oldest with a diagnostic", () => {
    const { router, diagnostics } = makeRouter({ maxPendingHoldFrames: 2 });
    router.registerSessionThread("session-thread");
    router.routeFrame(usageFrame("racing-child", "held-0"), 0);
    router.routeFrame(usageFrame("racing-child", "held-1"), 1);
    router.routeFrame(usageFrame("racing-child", "held-2"), 2);
    expect(router.pendingHeldFrameCount()).toBe(2);
    const shedRecords = diagnostics.recentRecordsOfKind("thread_pending_hold_shed");
    expect(shedRecords).toHaveLength(1);
    expect(shedRecords[0]?.rawWireType).toBe("held-0");
  });

  it("routing a frame also expires overdue holds first", () => {
    const { router, diagnostics } = makeRouter({ pendingRegistrationTimeoutMs: 500 });
    router.registerSessionThread("session-thread");
    router.routeFrame(usageFrame("never-announced"), 0);
    router.routeFrame(usageFrame("session-thread"), 1_000);
    expect(router.pendingHeldFrameCount()).toBe(0);
    expect(diagnostics.recentRecordsOfKind("thread_pending_hold_shed")).toHaveLength(1);
  });

  it("registration derives from declared lineage: an unrecognized parent refuses with a diagnostic", () => {
    const { router, diagnostics } = makeRouter();
    router.registerSessionThread("session-thread");
    for (const declaredParentThreadId of [null, "some-foreign-thread"]) {
      const registration = router.registerChildThread({
        childThreadId: "orphan-child",
        declaredParentThreadId,
        subagentId: "orphan-child",
      });
      expect(registration.registered).toBe(false);
    }
    expect(diagnostics.recentRecordsOfKind("thread_registration_refused")).toHaveLength(2);
    // The refused child never routes as registered.
    expect(router.routeFrame(usageFrame("orphan-child"), 0)).toEqual({
      decision: "held-pending-registration",
    });
  });

  it("a grandchild registers under an already-registered child's lineage", () => {
    const { router } = makeRouter();
    router.registerSessionThread("session-thread");
    router.registerChildThread({
      childThreadId: "child-thread",
      declaredParentThreadId: "session-thread",
      subagentId: "child-thread",
    });
    const grandchildRegistration = router.registerChildThread({
      childThreadId: "grandchild-thread",
      declaredParentThreadId: "child-thread",
      subagentId: "grandchild-thread",
    });
    expect(grandchildRegistration.registered).toBe(true);
    expect(router.routeFrame(usageFrame("grandchild-thread"), 0).decision).toBe("carve-out-usage");
  });
});
