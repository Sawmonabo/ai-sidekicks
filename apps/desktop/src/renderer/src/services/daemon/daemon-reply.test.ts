// The reply chokepoint on the parse arm: a reply off the contract never reaches a caller and a
// request off the contract never reaches the wire. Every case drives the real `callDaemon` over the
// real registry and the shipped fixture bridge, so a hand-rolled parser cannot pass with the
// shipped one deleted. Rejections are in `daemon-reply.rejections.test.ts`; the shared helpers are
// `tests/helpers/daemon-reply-refusal.ts` and `fixture-bridge.ts`.

import type { SessionId } from "@ai-sidekicks/contracts";

import { isRefusal } from "@renderer/lib/refusal.js";
import { callDaemon, DAEMON_REPLY_REFUSAL_ORIGIN } from "./daemon-reply.js";
import { describeFailingPaths } from "./failing-member-paths.js";
import { refusalOf } from "@test/helpers/daemon-reply-refusal.js";
import { bridgeAnswering } from "@test/helpers/fixture-bridge.js";

/** A device id the response schema accepts. */
const DEVICE_ID = "device-workstation";

/** A device state the response schema accepts. */
const ONLINE = "online";

/** A value the response schema rejects, shaped like content a refusal detail must never carry. */
const OFF_CONTRACT = "the person said something private";

/** One served presence reply, in the shape the registered schema admits. */
function servedPresenceReply(state: string, count = 1): unknown {
  return {
    devices: Array.from({ length: count }, () => ({
      deviceId: DEVICE_ID,
      deviceType: "desktop",
      appVisible: true,
      state,
    })),
  };
}

describe("callDaemon — a served reply is a parsed reply", () => {
  it("serves the registered shape the daemon answered with", async () => {
    const { bridge, calls } = bridgeAnswering(async () => servedPresenceReply(ONLINE));

    const reply = await callDaemon(bridge, "presence.read", {});

    expect(calls).toStrictEqual([{ method: "presence.read", params: {} }]);
    expect(reply.status).toBe("served");
    if (reply.status === "served") {
      // Read through the bound response type, so a row pointing at the wrong schema also
      // fails at compile time.
      expect(reply.value.devices[0]?.deviceId).toBe(DEVICE_ID);
    }
  });

  it("negative control: the same call refuses when one member is off-contract", async () => {
    // Without it, the case above passes for a `callDaemon` that parsed nothing.
    const { bridge } = bridgeAnswering(async () => ({
      devices: [
        {
          deviceId: DEVICE_ID,
          deviceType: "desktop",
          appVisible: true,
          state: "loitering",
        },
      ],
    }));

    const reply = await callDaemon(bridge, "presence.read", {});

    expect(refusalOf(reply).code).toBe("reply-unreadable");
  });
});

describe("callDaemon — a reply the contract does not admit is a refusal", () => {
  it("refuses an entirely wrong reply under the console's own code and origin", async () => {
    const { bridge } = bridgeAnswering(async () => ({ rows: [] }));

    const refusal = refusalOf(await callDaemon(bridge, "presence.read", {}));

    expect(refusal.code).toBe("reply-unreadable");
    expect(refusal.origin).toBe(DAEMON_REPLY_REFUSAL_ORIGIN);
    expect(refusal.detail).toContain("presence.read");
    expect(isRefusal(refusal)).toBe(true);
  });

  it("names the failing member path", async () => {
    const { bridge } = bridgeAnswering(async () => servedPresenceReply(OFF_CONTRACT));

    const refusal = refusalOf(await callDaemon(bridge, "presence.read", {}));

    expect(refusal.detail).toContain("devices.0.state");
  });

  it("never puts the refused VALUE in the sentence a person reads", async () => {
    // `callDaemon` composes its own sentence because the validator's interpolates the
    // rejected member, which can be a user's words, a path or a credential.
    const { bridge } = bridgeAnswering(async () => servedPresenceReply(OFF_CONTRACT));

    const refusal = refusalOf(await callDaemon(bridge, "presence.read", {}));

    expect(refusal.detail).not.toContain(OFF_CONTRACT);
  });

  it("bounds how many paths it names", async () => {
    // The cap keeps the detail a sentence; without it the refusal card renders a list.
    const { bridge } = bridgeAnswering(async () => servedPresenceReply(OFF_CONTRACT, 12));

    const refusal = refusalOf(await callDaemon(bridge, "presence.read", {}));

    expect(refusal.detail).toContain("and more");
    expect(refusal.detail.match(/devices\.\d+\.state/gu)).toHaveLength(3);
  });
});

describe("callDaemon — a request the contract does not admit is never sent", () => {
  it("refuses before the call, and the daemon sees nothing", async () => {
    const { bridge, calls } = bridgeAnswering(async () => servedPresenceReply(ONLINE));

    // The branded id is a compile-time marker over a string, so a caller can hand this seam a
    // value the wire would refuse; the parse stops it becoming a failing round trip.
    const refusal = refusalOf(
      await callDaemon(bridge, "session.read", {
        sessionId: "not-a-session-id" as SessionId,
      }),
    );

    expect(refusal.code).toBe("request-unsendable");
    expect(refusal.origin).toBe(DAEMON_REPLY_REFUSAL_ORIGIN);
    expect(refusal.detail).toContain("session.read");
    expect(calls).toStrictEqual([]);
  });

  it("what reaches the daemon is the parser's output, not the caller's object", async () => {
    // A forwarded reference would let a caller keep mutating an object already declared
    // sendable, and would skip any normalization the schema applies.
    const { bridge, calls } = bridgeAnswering(async () => servedPresenceReply(ONLINE));
    const request = {};

    await callDaemon(bridge, "presence.read", request);

    expect(calls[0]?.params).toStrictEqual(request);
    expect(calls[0]?.params).not.toBe(request);
  });
});

describe("describeFailingPaths — a shape it cannot read yields no clause", () => {
  // Driven directly: `callDaemon` always passes a real validator error, but the parameter is
  // typed `unknown`.

  it("answers an empty clause for the two values a property read throws on", () => {
    expect(describeFailingPaths(null)).toBe("");
    expect(describeFailingPaths(undefined)).toBe("");
  });

  it("answers an empty clause when reading `issues` throws", () => {
    const hostile: unknown = {
      get issues(): never {
        throw new Error("this getter is the defect");
      },
    };

    expect(describeFailingPaths(hostile)).toBe("");
  });

  it("skips an issue whose own `path` cannot be read, and keeps the rest", () => {
    const mixed: unknown = {
      issues: [
        {
          get path(): never {
            throw new Error("this getter is the defect");
          },
        },
        { path: ["devices", 0, "state"] },
      ],
    };

    expect(describeFailingPaths(mixed)).toBe(" (at devices.0.state)");
  });

  it("names a segment it cannot render rather than throwing on it", () => {
    // `String(...)` throws on a null-prototype value, so the segment goes through
    // `lossyStringify`, which cannot throw.
    const unrenderable: unknown = { issues: [{ path: [Object.create(null)] }] };

    expect(describeFailingPaths(unrenderable)).toBe(" (at [unrepresentable value])");
  });

  it("negative control: an ordinary validator error still names its members", () => {
    // Without it, a guard that answered `""` for everything passes the four cases above.
    const error: unknown = { issues: [{ path: ["devices", 0, "state"] }] };

    expect(describeFailingPaths(error)).toBe(" (at devices.0.state)");
  });
});
