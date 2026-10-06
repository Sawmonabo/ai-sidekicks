// A link reports one connect, at most one error and exactly one loss, however many closes and
// timers race to end it, so nothing above counts a loss twice.

import { JsonRpcTransportPeerClosedError } from "@ai-sidekicks/client-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LINK_DEAD_MS, LinkLifetime } from "./lifetime.js";

let reported: string[];
let lifetime: LinkLifetime;

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
  reported = [];
  lifetime = new LinkLifetime(
    {
      connected: () => reported.push("connected"),
      quiet: () => reported.push("quiet"),
      errored: (message) => reported.push(`errored: ${message}`),
      lost: (cause) => reported.push(`lost: ${cause.kind}`),
    },
    () => {
      // The socket closing reports back as a close main caused.
      lifetime.closed(undefined);
    },
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe("one link's reports", () => {
  it("reports one connect, one error and one loss when a broken close races the dead line", () => {
    lifetime.open();
    lifetime.open();
    lifetime.closed(new Error("the frame header was malformed"));
    lifetime.closed(new JsonRpcTransportPeerClosedError());
    vi.advanceTimersByTime(LINK_DEAD_MS * 2);

    expect(reported).toStrictEqual([
      "connected",
      "errored: the frame header was malformed",
      "lost: unrecognized",
    ]);
  });

  it("reports a silent link's error and loss once, and the close it causes adds nothing", () => {
    lifetime.open();
    vi.advanceTimersByTime(LINK_DEAD_MS);
    lifetime.closed(new JsonRpcTransportPeerClosedError());

    expect(reported).toStrictEqual([
      "connected",
      "quiet",
      "errored: No frame from the background service for 20 seconds",
      "lost: silence",
    ]);
  });

  it("reports a service that went away as a loss with no error", () => {
    lifetime.open();
    lifetime.closed(new JsonRpcTransportPeerClosedError());

    expect(reported).toStrictEqual(["connected", "lost: serviceGone"]);
  });

  it("reports nothing for a handshake that never completed", () => {
    lifetime.frameReceived();
    lifetime.closed(new Error("refused"));
    vi.advanceTimersByTime(LINK_DEAD_MS * 2);

    expect(reported).toStrictEqual([]);
  });
});
