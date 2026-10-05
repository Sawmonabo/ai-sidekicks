// The workflow stream stays open for its reader: one that ends after delivering is opened again at
// once, one that ends before delivering waits for the transport to come back, each re-open tells
// the reader it missed the gap, a re-open that throws hands on its refusal until one works, and a
// released stream is never opened again.

import { describe, expect, it } from "vitest";

import type { DaemonSubscriptionEnd } from "@shared/daemon-forwarding.js";
import { bridgeAnswering, withDaemonSubscribe } from "@test/helpers/fixture-bridge.js";
import { ManualClock } from "@renderer/lib/clock.js";
import { REOPEN_WAITS_MS } from "../transport/reopening-subscription.js";
import { subscribeWorkflowNotices, type WorkflowNoticeFrame } from "./workflow-notices.js";

/** One open the stream made: what delivers a frame on it, and what ends it. */
interface StreamOpen {
  readonly deliver: (payload: unknown) => void;
  readonly end: (end: DaemonSubscriptionEnd) => void;
}

const LINK_FAILED: DaemonSubscriptionEnd = { reason: "failed", message: "the link went away" };

describe("the workflow stream", () => {
  it("opens again after it ends, at once or once the transport is back, until released", () => {
    const opens: StreamOpen[] = [];
    const base = bridgeAnswering(async (_call, passThrough) => passThrough()).bridge;
    const bridge = withDaemonSubscribe(base, (_passThrough, handler, _request, onEnded) => {
      opens.push({ deliver: handler, end: (end) => onEnded?.(end) });
      return () => undefined;
    });
    const frames: WorkflowNoticeFrame["kind"][] = [];
    const release = subscribeWorkflowNotices(bridge, new ManualClock(), (frame) => {
      frames.push(frame.kind);
    });
    expect(opens).toHaveLength(1);

    // Ended after it delivered: opened again at once, and the reader told it missed the gap.
    opens[0]?.deliver({ kind: "not a notice" });
    opens[0]?.end(LINK_FAILED);
    expect(opens).toHaveLength(2);
    expect(frames).toStrictEqual(["unreadable", "reopened"]);

    // Ended before it delivered: not asked again until the transport comes back.
    opens[1]?.end(LINK_FAILED);
    expect(opens).toHaveLength(2);
    bridge.transportReconnect.observe("unreachable");
    bridge.transportReconnect.observe("reachable");
    expect(opens).toHaveLength(3);
    expect(frames).toStrictEqual(["unreadable", "reopened", "reopened"]);

    // Released: an end heard afterwards opens nothing.
    release();
    opens[2]?.deliver({ kind: "not a notice" });
    opens[2]?.end(LINK_FAILED);
    expect(opens).toHaveLength(3);
  });

  it("hands on the refusal of a re-open that throws, then the re-open that works after it", () => {
    const clock = new ManualClock();
    const ends: ((end: DaemonSubscriptionEnd) => void)[] = [];
    let isRefusing = false;
    const base = bridgeAnswering(async (_call, passThrough) => passThrough()).bridge;
    const bridge = withDaemonSubscribe(base, (_passThrough, handler, _request, onEnded) => {
      if (isRefusing) {
        throw new Error("the daemon declined the stream");
      }
      ends.push((end) => onEnded?.(end));
      handler({ kind: "not a notice" });
      return () => undefined;
    });
    const frames: WorkflowNoticeFrame[] = [];
    const release = subscribeWorkflowNotices(bridge, clock, (frame) => {
      frames.push(frame);
    });
    frames.length = 0;

    isRefusing = true;
    ends[0]?.(LINK_FAILED);
    expect(frames.map((frame) => frame.kind)).toStrictEqual(["reopenRefused"]);
    expect(frames[0]?.kind === "reopenRefused" ? frames[0].refusal.code : "").toBe(
      "subscription-reopen-failed",
    );

    // The next try comes after a wait, and once it works the reader hears the stream reopened.
    isRefusing = false;
    clock.advance(REOPEN_WAITS_MS[1]!);
    expect(frames.map((frame) => frame.kind)).toStrictEqual([
      "reopenRefused",
      "unreadable",
      "reopened",
    ]);
    release();
  });
});
