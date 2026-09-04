// Two claims, and the second is the one that recurred: the arms keep the refusing
// side's own code, and the function is total against a value that fights back.
//
// The totality cases are not hypothetical. A hostile value reaches this function on
// the ordinary path — a rejection is whatever a producer threw, and `String(...)` on
// a null-prototype object throws inside the expression that exists to say something
// failed, leaving a control busy forever because the `catch` that would have cleared
// it had already been left.

import { describe, expect, it } from "vitest";

import { ConsoleRefusalError, isConsoleRefusal, refuse } from "./refusal.js";
import { normalizeWireRejection } from "./wire-rejection.js";

/** A value whose every property access throws. The worst case, built once. */
function hostileValue(): unknown {
  return new Proxy(
    {},
    {
      get() {
        throw new Error("this getter is hostile");
      },
    },
  );
}

/** A null-prototype object: `String(...)` on it throws, `lossyStringify` does not. */
function nullPrototypeValue(): unknown {
  return Object.create(null) as unknown;
}

describe("normalizeWireRejection — the refusing side's own code survives", () => {
  it("passes a refusal through untouched, keeping the author it names", () => {
    const original = refuse("growth-port", "wire-unregistered", "No wire carries this yet.");
    expect(normalizeWireRejection("repos", original)).toBe(original);
  });

  it("unwraps a carried refusal structurally, not by prototype", () => {
    const carried = refuse("persistence", "quota-exceeded", "The store is full.");
    expect(normalizeWireRejection("repos", new ConsoleRefusalError(carried))).toStrictEqual(
      carried,
    );
    // The control that makes "structurally" mean something: a plain object carrying
    // the same member is unwrapped identically. A value that crossed a realm or a
    // structured clone has no prototype chain left, and an `instanceof` check would
    // silently drop its author's code and invent one.
    expect(normalizeWireRejection("repos", { refusal: carried })).toStrictEqual(carried);
  });

  it("takes the dotted project code off a JSON-RPC error envelope", () => {
    // `JsonRpcRemoteError` carries the JSON-RPC NUMERIC as `code` and the project's
    // dotted code at `data.type`; `packages/contracts` states callers must
    // discriminate on the latter. The negative control below is what every
    // hand-written normalizer did instead.
    const remote = Object.assign(new Error("That session is not on this node."), {
      code: -32603,
      data: { type: "session.not_found" },
    });
    const refusal = normalizeWireRejection("collaboration", remote);
    expect(refusal.code).toBe("session.not_found");
    expect(refusal.detail).toBe("That session is not on this node.");
    expect(refusal.origin).toBe("collaboration");
    expect(refusal.code).not.toBe("collaboration-call-failed");
  });

  it("keeps a flat envelope's code and message verbatim", () => {
    const refusal = normalizeWireRejection("repos", {
      code: "repo.outside_trust_envelope",
      message: "That path is outside the admitted root.",
    });
    expect(refusal).toStrictEqual(
      refuse("repos", "repo.outside_trust_envelope", "That path is outside the admitted root."),
    );
  });

  it("recognizes an Error subclass carrying a wire code the same way", () => {
    const sdkError = Object.assign(new Error("Another node holds that attachment."), {
      code: "runtimenode.attach_conflict",
    });
    expect(normalizeWireRejection("collaboration", sdkError).code).toBe(
      "runtimenode.attach_conflict",
    );
  });

  it("prefers the dotted code over a flat one when a value carries both", () => {
    const refusal = normalizeWireRejection("repos", {
      code: "transport.flattened",
      message: "…",
      data: { type: "repo.not_found" },
    });
    expect(refusal.code).toBe("repo.not_found");
  });

  it("uses the caller's fallback only where nothing machine-readable arrived", () => {
    const fallback = { code: "stream-never-opened", detail: "The subscription never opened." };
    expect(normalizeWireRejection("runs", new Error("socket closed"), fallback).code).toBe(
      "stream-never-opened",
    );
    // And never displaces a code the other side sent — the whole reason the typed
    // arms run first.
    expect(
      normalizeWireRejection("runs", { code: "run.not_found", message: "gone" }, fallback).code,
    ).toBe("run.not_found");
  });

  it("synthesizes a code naming the seam when there is no fallback and no envelope", () => {
    const refusal = normalizeWireRejection("keybindings", new Error("boom"));
    expect(refusal).toStrictEqual(refuse("keybindings", "keybindings-call-failed", "boom"));
  });
});

describe("normalizeWireRejection — the retry bound the wire registered", () => {
  it("reads seconds and a reset instant off a JSON-RPC fields payload", () => {
    const refusal = normalizeWireRejection("collaboration", {
      code: -32603,
      message: "Too many invites.",
      data: {
        type: "ratelimit.exceeded",
        fields: { retryAfter: 30, resetAt: "2026-09-01T12:00:30Z" },
      },
    });
    expect(refusal.retry).toStrictEqual({
      afterSeconds: 30,
      atEpochMilliseconds: Date.UTC(2026, 8, 1, 12, 0, 30),
    });
  });

  it("reads the same pair off a flat envelope", () => {
    expect(
      normalizeWireRejection("collaboration", {
        code: "ratelimit.exceeded",
        message: "Slow down.",
        retryAfter: 5,
      }).retry,
    ).toStrictEqual({ afterSeconds: 5 });
  });

  it("omits the member entirely where the wire named no bound", () => {
    // "Retry immediately" and "the refusing side said nothing about retrying" are
    // different facts. A present-but-empty hint would render the second as the first.
    const refusal = normalizeWireRejection("repos", { code: "repo.not_found", message: "gone" });
    expect(refusal.retry).toBeUndefined();
    expect(Object.hasOwn(refusal, "retry")).toBe(false);
  });

  it("drops a reset instant it cannot read rather than reporting a wrong one", () => {
    // The concurrency-cap refusals register no timing pair at all, so a malformed one
    // is a producer defect; the surface renders no countdown rather than a countdown
    // to a date that does not exist.
    expect(
      normalizeWireRejection("collaboration", {
        code: "ratelimit.exceeded",
        message: "…",
        resetAt: "2026-02-30T12:00:00Z",
      }).retry,
    ).toBeUndefined();
  });

  it("ignores a negative or non-finite second count", () => {
    expect(
      normalizeWireRejection("collaboration", { code: "x", message: "y", retryAfter: -1 }).retry,
    ).toBeUndefined();
    expect(
      normalizeWireRejection("collaboration", { code: "x", message: "y", retryAfter: "soon" })
        .retry,
    ).toBeUndefined();
  });
});

describe("normalizeWireRejection — total against a value that fights back", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", "the call failed"],
    ["a number", 42],
    ["a symbol", Symbol("thrown")],
    ["a plain object", { unexpected: true }],
    ["an array", [1, 2, 3]],
    ["a function", () => undefined],
  ])("answers a refusal for %s", (_label, thrown) => {
    const refusal = normalizeWireRejection("browser", thrown);
    expect(isConsoleRefusal(refusal)).toBe(true);
    expect(refusal.code).toBe("browser-call-failed");
    expect(refusal.origin).toBe("browser");
  });

  it("answers a refusal for a null-prototype object, where String(...) throws", () => {
    const value = nullPrototypeValue();
    expect(() => String(value)).toThrow();
    const refusal = normalizeWireRejection("browser", value);
    expect(refusal.code).toBe("browser-call-failed");
    expect(refusal.detail).toBe("[unrepresentable value]");
  });

  it("answers a refusal for a value whose every property access throws", () => {
    const value = hostileValue();
    expect(() => (value as { code: unknown }).code).toThrow();
    const refusal = normalizeWireRejection("browser", value);
    expect(isConsoleRefusal(refusal)).toBe(true);
    expect(refusal.code).toBe("browser-call-failed");
  });

  it("answers a refusal for a circular object", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(isConsoleRefusal(normalizeWireRejection("browser", circular))).toBe(true);
  });

  it("answers a refusal for an Error whose message getter throws", () => {
    const thrown = new Error("unreadable");
    Object.defineProperty(thrown, "message", {
      get() {
        throw new Error("this getter is hostile too");
      },
    });
    const refusal = normalizeWireRejection("browser", thrown);
    expect(refusal.code).toBe("browser-call-failed");
    expect(typeof refusal.detail).toBe("string");
  });

  it("answers a refusal for a hostile value carrying a hostile refusal member", () => {
    const thrown = {
      get refusal(): never {
        throw new Error("hostile refusal getter");
      },
    };
    expect(normalizeWireRejection("browser", thrown).code).toBe("browser-call-failed");
  });
});
