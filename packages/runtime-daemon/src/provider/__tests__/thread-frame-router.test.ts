// The thread-frame router decides where each provider frame goes: the session transcript, a
// child's usage or approval carve-out, a held registration race, or quarantine. A frame is never
// guessed into the parent, and child spend is attributed by declared lineage.

import { describe, expect, it } from "vitest";

import { makeSilentDriverDiagnostics } from "../__fixtures__/silent-driver-diagnostics.js";
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
  const diagnostics = makeSilentDriverDiagnostics();
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

describe("ThreadFrameRouter", () => {
  it("connection-scoped families route without a thread id", () => {
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
    expect(diagnostics.recentRecordsOfKind("thread_frame_quarantined")).toHaveLength(1);
  });

  it("the quarantine buffer is bounded: oldest shed first, each shed a diagnostic", () => {
    const { router, diagnostics } = makeRouter({ maxQuarantinedFrames: 2 });
    router.registerSessionThread("session-thread");
    router.routeFrame(usageFrame(null, "bad-frame-0"), 0);
    router.routeFrame(usageFrame(null, "bad-frame-1"), 1);
    router.routeFrame(usageFrame(null, "bad-frame-2"), 2);
    expect(diagnostics.recentRecordsOfKind("thread_quarantine_shed")).toHaveLength(1);
    expect(diagnostics.recentRecordsOfKind("thread_quarantine_shed")[0]?.rawWireType).toBe(
      "bad-frame-0",
    );
  });

  it("child usage carves out under the subagent, or under the parent run for a provider-internal child", () => {
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
    // A compaction thread has no subagent id: its spend is the parent run's.
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
    // Once per child thread: content deltas must not flood the channel.
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

  it("registering the SESSION's own thread releases the holds that were waiting on it", () => {
    const { router } = makeRouter();
    // No session thread registered: the process has spawned but the provider has not announced its
    // thread identity, so a frame in that window names an identity the router cannot match.
    const earlyFrame = usageFrame("session-thread", "early-session-usage");
    expect(router.routeFrame(earlyFrame, 0)).toEqual({ decision: "held-pending-registration" });
    expect(router.pendingHeldFrameCount()).toBe(1);

    // Releasing on child registration only would shed this frame at its timeout, silently losing
    // the session's own usage.
    const releasedFrames = router.registerSessionThread("session-thread");
    expect(releasedFrames.map((frame) => frame.rawWireType)).toEqual(["early-session-usage"]);
    expect(router.pendingHeldFrameCount()).toBe(0);
    expect(router.routeFrame(earlyFrame, 1)).toEqual({ decision: "project" });
  });

  it("session-thread registration releases only the frames that named THAT thread", () => {
    const { router } = makeRouter();
    router.routeFrame(usageFrame("session-thread", "mine"), 0);
    router.routeFrame(usageFrame("some-other-thread", "not-mine"), 0);

    const releasedFrames = router.registerSessionThread("session-thread");
    expect(releasedFrames.map((frame) => frame.rawWireType)).toEqual(["mine"]);
    // The foreign identity stays held: it is still unregistered, and releasing it would project a
    // thread nobody announced.
    expect(router.pendingHeldFrameCount()).toBe(1);
  });

  it("completing a child drops its attribution so a later frame stops carving out", () => {
    const { router } = makeRouter();
    router.registerSessionThread("session-thread");
    router.registerChildThread({
      childThreadId: "child-thread",
      declaredParentThreadId: "session-thread",
      subagentId: "child-thread",
    });
    expect(router.childAttributionFor("child-thread")).toEqual({
      kind: "subagent",
      subagentId: "child-thread",
    });

    const completion = router.completeChildThread("child-thread");
    expect(completion.wasRegistered).toBe(true);
    expect(completion.abandonedPendingFrames).toEqual([]);
    expect(router.childAttributionFor("child-thread")).toBeUndefined();
    // A frame after the child's terminal holds pending a registration that never comes and is
    // shed at the timeout rather than metered onto a closed child.
    expect(router.routeFrame(usageFrame("child-thread"), 0)).toEqual({
      decision: "held-pending-registration",
    });
  });
});
