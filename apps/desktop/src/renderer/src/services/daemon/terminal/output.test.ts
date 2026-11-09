// One shell's output stream over a fake daemon wire: each open hands on its subscription's id, a
// frame arrives checked with its bytes in place, a stream that ends opens again after the newest
// offset, an unreadable frame opens it again from no offset, and a released stream is closed and
// never opened again.

import { describe, expect, it, vi } from "vitest";

import type { SubscriptionId } from "@ai-sidekicks/contracts/jsonrpc/streaming";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { TerminalId } from "@ai-sidekicks/contracts/terminal";

import type { DaemonSubscriptionEnd } from "#shared/daemon/forwarding.js";
import type { DaemonWire } from "#shared/preload-api.js";
import type { PlatformBridge } from "../../platform/bridge.js";
import { TransportReconnectSignal } from "../../transport/reconnect.js";
import { followShellOutput, type ShellOutputDelivery } from "./output.js";

const SHELL = {
  sessionId: "019b7b30-0280-79a4-8110-cca0117a0135" as SessionId,
  terminalId: "terminal-1" as TerminalId,
};
const SUBSCRIPTION_ID = "019b7b30-0280-79a4-8110-cca0117a0136" as SubscriptionId;

/** One open of the stream: its request, its ends and whether the page closed it. */
interface StreamOpen {
  readonly params: unknown;
  readonly deliver: (payload: unknown, attachments: readonly Uint8Array[]) => void;
  readonly end: (end: DaemonSubscriptionEnd) => void;
  readonly opened: (subscriptionId: SubscriptionId) => void;
  isClosed: boolean;
}

/** A bridge whose only member in use is a daemon wire that records each stream it opens. */
function bridgeRecordingOpens(): { readonly bridge: PlatformBridge; readonly opens: StreamOpen[] } {
  const opens: StreamOpen[] = [];
  const subscribe = ((
    _event: string,
    params: unknown,
    handler: StreamOpen["deliver"],
    onEnded?: StreamOpen["end"],
    onOpened?: StreamOpen["opened"],
  ) => {
    const open: StreamOpen = {
      params,
      deliver: handler,
      end: (end) => onEnded?.(end),
      opened: (subscriptionId) => onOpened?.(subscriptionId),
      isClosed: false,
    };
    opens.push(open);
    return () => {
      open.isClosed = true;
    };
  }) as DaemonWire["subscribe"];
  const bridge = {
    daemon: { subscribe },
    transportReconnect: new TransportReconnectSignal(),
  } as unknown as PlatformBridge;
  return { bridge, opens };
}

describe("a shell's output stream", () => {
  it("hands on ids and placed bytes, resumes after its offset, redraws past an unreadable frame, and closes on release", async () => {
    const { bridge, opens } = bridgeRecordingOpens();
    const deliveries: ShellOutputDelivery[] = [];
    const release = followShellOutput(bridge, SHELL, (delivery) => {
      deliveries.push(delivery);
    });
    expect(opens.map((open) => open.params)).toStrictEqual([SHELL]);

    const bytes = new TextEncoder().encode("ls\n");
    opens[0]?.opened(SUBSCRIPTION_ID);
    opens[0]?.deliver({ changes: [{ kind: "output", ...SHELL, data: { $bytes: 0 }, cursor: 3 }] }, [
      bytes,
    ]);
    expect(deliveries).toStrictEqual([
      { kind: "opened", subscriptionId: SUBSCRIPTION_ID },
      { kind: "frame", frame: { changes: [{ kind: "output", ...SHELL, data: bytes, cursor: 3 }] } },
    ]);

    // Ended after it delivered: opened again past what was drawn.
    opens[0]?.end({ reason: "failed", message: "the link went away" });
    await vi.waitFor(() => {
      expect(opens).toHaveLength(2);
    });
    expect(opens[1]?.params).toStrictEqual({ ...SHELL, afterOffset: 3 });

    // Unreadable: this stream is closed and the next one asks for the whole window again.
    opens[1]?.deliver({ changes: [{ kind: "output", ...SHELL, cursor: 9 }] }, []);
    expect(opens[1]?.isClosed).toBe(true);
    expect(opens[2]?.params).toStrictEqual(SHELL);
    expect(deliveries).toHaveLength(2);

    release();
    expect(opens[2]?.isClosed).toBe(true);
    opens[2]?.end({ reason: "failed", message: "the link went away" });
    expect(opens).toHaveLength(3);
  });
});
