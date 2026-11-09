// One shell's output stream over a fake daemon wire: each open hands on its subscription's id, a
// frame arrives checked with its bytes in place, a stream that ends says so and opens again after
// the newest offset, an unreadable frame opens it again from no offset, and a released stream is
// closed and never opened again.

import { describe, expect, it, vi } from "vitest";

import type { SubscriptionId } from "@ai-sidekicks/contracts/jsonrpc/streaming";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { TerminalId } from "@ai-sidekicks/contracts/terminal";

import { followShellOutput, type ShellOutputDelivery } from "./output.js";
import { RecordedShellWire } from "./output.test-support.js";

const SHELL = {
  sessionId: "019b7b30-0280-79a4-8110-cca0117a0135" as SessionId,
  terminalId: "terminal-1" as TerminalId,
};
const SUBSCRIPTION_ID = "019b7b30-0280-79a4-8110-cca0117a0136" as SubscriptionId;

describe("a shell's output stream", () => {
  it("hands on ids and placed bytes, resumes after its offset, redraws past an unreadable frame, and closes on release", async () => {
    const { bridge, opens } = new RecordedShellWire();
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

    // Ended after it delivered: said, and opened again past what was drawn.
    opens[0]?.end({ reason: "failed", message: "the link went away" });
    expect(deliveries.at(-1)).toStrictEqual({ kind: "ended" });
    await vi.waitFor(() => {
      expect(opens).toHaveLength(2);
    });
    expect(opens[1]?.params).toStrictEqual({ ...SHELL, afterOffset: 3 });

    // Unreadable: this stream is closed and the next one asks for the whole window again.
    opens[1]?.deliver({ changes: [{ kind: "output", ...SHELL, cursor: 9 }] }, []);
    expect(opens[1]?.isClosed).toBe(true);
    expect(opens[2]?.params).toStrictEqual(SHELL);
    expect(deliveries.slice(2)).toStrictEqual([{ kind: "ended" }, { kind: "ended" }]);

    release();
    expect(opens[2]?.isClosed).toBe(true);
    opens[2]?.end({ reason: "failed", message: "the link went away" });
    expect(opens).toHaveLength(3);
  });
});
