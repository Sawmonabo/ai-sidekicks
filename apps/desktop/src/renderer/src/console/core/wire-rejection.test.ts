// Two claims, and the second is the one that recurred: the arms keep the refusing
// side's own code, and the function is total against a value that fights back.
//
// The totality cases are not hypothetical. A hostile value reaches this function on
// the ordinary path — a rejection is whatever a producer threw, and `String(...)` on
// a null-prototype object throws inside the expression that exists to say something
// failed, leaving a control busy forever because the `catch` that would have cleared
// it had already been left.

import { describe, expect, it } from "vitest";

import {
  everyTrapThrows,
  nullPrototypeValue,
  readableOnce,
  revokedProxy,
} from "../../../../shared/wire-errors.test-support.js";
import { readRefusalExtensions } from "./refusal-extensions.js";
import { ConsoleRefusalError, isConsoleRefusal, refuse } from "./refusal.js";
import { normalizeWireRejection } from "./wire-rejection.js";

/**
 * A value whose every property access throws, and nothing else does.
 *
 * Stays here rather than joining the shared fixtures: it has one reader, and the
 * shared home holds the roles more than one suite plays. It is deliberately weaker
 * than `everyTrapThrows` below — the claim it drives is totality against a READ, and
 * a value that also breaks `instanceof` would prove that arm and hide this one.
 */
function throwingGetProxy(): unknown {
  return new Proxy(
    {},
    {
      get(): never {
        throw new Error("this getter is hostile");
      },
    },
  );
}

describe("normalizeWireRejection — the refusing side's own code survives", () => {
  it("keeps a refusal's own author, code and sentence, on an object of its own", () => {
    const original = refuse("growth-port", "wire-unregistered", "No wire carries this yet.");
    const normalized = normalizeWireRejection("repos", original);
    expect(normalized).toStrictEqual(original);
    // REBUILT, not returned. The identity is what used to be asserted here, and it is
    // exactly what let a hostile candidate reach the renderer — see the totality
    // cases below, where the same rebuild is what keeps `refusal.code` readable.
    expect(normalized).not.toBe(original);
  });

  it("carries a retry hint through the rebuild rather than dropping it", () => {
    const original = {
      ...refuse("collaboration", "ratelimit.exceeded", "Slow down."),
      retry: {
        afterSeconds: 30,
        atEpochMilliseconds: Date.UTC(2026, 8, 1, 12, 0, 30),
      },
    };
    expect(normalizeWireRejection("repos", original).retry).toStrictEqual(original.retry);
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

describe("normalizeWireRejection — the failed bindings a goal refusal names", () => {
  it("reads the id list off the same `data.fields` payload the retry bound rides", () => {
    const refusal = normalizeWireRejection("approvals", {
      code: -32603,
      message: "The goal was not delivered to every bound agent.",
      data: {
        type: "session.goal_delivery_failed",
        fields: { failedBindingIds: ["binding-a", "binding-b"], driverCode: "driver.timeout" },
      },
    });
    expect(readRefusalExtensions(refusal).failedBindingIds).toStrictEqual([
      "binding-a",
      "binding-b",
    ]);
  });

  it("negative control: the sibling `driverCode` is not registered and does not survive", () => {
    // The point of the registry: a member off `data.fields` reaches a surface only
    // because a reader was registered for it, never because the wire carried it.
    const refusal = normalizeWireRejection("approvals", {
      code: -32603,
      message: "…",
      data: { type: "session.goal_delivery_failed", fields: { driverCode: "driver.timeout" } },
    });
    expect(Object.hasOwn(refusal, "driverCode")).toBe(false);
    expect(readRefusalExtensions(refusal)).toStrictEqual({});
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
    const value = throwingGetProxy();
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

  it("answers a refusal for a revoked Proxy, which `instanceof` throws on", () => {
    // The value `instanceof` cannot be asked about: `[[GetPrototypeOf]]` on a revoked
    // Proxy throws, and the terminal arm's prototype question sits OUTSIDE the
    // backstop `try`. The first assertion is the negative control — it is the exact
    // expression this module used to evaluate on this exact value.
    const revoked = revokedProxy();
    expect(() => revoked instanceof Error).toThrow();
    const refusal = normalizeWireRejection("browser", revoked);
    expect(isConsoleRefusal(refusal)).toBe(true);
    expect(refusal.code).toBe("browser-call-failed");
    expect(refusal.detail).toBe("[unrepresentable value]");
  });

  it("answers a refusal for a Proxy whose every trap throws, prototype included", () => {
    const hostile = everyTrapThrows();
    expect(() => hostile instanceof Error).toThrow();
    const refusal = normalizeWireRejection("browser", hostile);
    expect(refusal.code).toBe("browser-call-failed");
    expect(refusal.origin).toBe("browser");
    expect(typeof refusal.detail).toBe("string");
  });
});

describe("normalizeWireRejection — nothing of the rejection survives onto the answer", () => {
  /**
   * A refusal-shaped value whose three members are each readable exactly once.
   *
   * The shape that made returning the candidate a deferred throw: the guard reads
   * three strings and says yes, and the renderer's own `refusal.code` — one layer
   * later, outside every `catch` — is the second read.
   */
  function readableOnceRefusal(): unknown {
    return readableOnce({
      code: ["persistence.quota_exceeded"],
      detail: ["The store is full."],
      origin: ["persistence"],
    });
  }

  it("hands the renderer a refusal it can read as many times as it renders", () => {
    const refusal = normalizeWireRejection("repos", readableOnceRefusal());
    expect(refusal).toStrictEqual(
      refuse("persistence", "persistence.quota_exceeded", "The store is full."),
    );
    // The claim, spelled as the renderer makes it: three reads, three answers, no
    // throw. Against a returned candidate the second one throws.
    for (let render = 0; render < 3; render += 1) {
      expect(refusal.code).toBe("persistence.quota_exceeded");
      expect(refusal.detail).toBe("The store is full.");
      expect(refusal.origin).toBe("persistence");
    }
  });

  it("negative control: the candidate itself is not readable twice", () => {
    const candidate = readableOnceRefusal() as { readonly code: string };
    expect(candidate.code).toBe("persistence.quota_exceeded");
    expect(() => candidate.code).toThrow();
  });

  it("rebuilds a CARRIED refusal too, not only one the rejection is", () => {
    // The `ConsoleRefusalError` arm. Reading the answer twice is the identity claim
    // spelled the only way it can be here: the candidate is unreadable a second time,
    // so an answer that reads twice is provably not the candidate.
    const refusal = normalizeWireRejection("repos", { refusal: readableOnceRefusal() });
    expect(refusal.code).toBe("persistence.quota_exceeded");
    expect(refusal.code).toBe("persistence.quota_exceeded");
    expect(refusal.origin).toBe("persistence");
  });
});

describe("normalizeWireRejection — each member is read once", () => {
  /** A flat envelope whose `code` answers one thing on the first read and another after. */
  function envelopeAnsweringOnce(): unknown {
    return readableOnce({
      code: ["session.not_found", "session.forbidden"],
      message: ["No such session."],
    });
  }

  it("classifies a flat envelope on its first reading of the code", () => {
    // The first arm reads `code` to ask whether the value IS a refusal; the flat
    // envelope arm used to read it again. A code that changes between the two
    // readings was classified on the second and rendered as a refusal the wire never
    // sent.
    const refusal = normalizeWireRejection("ledger", envelopeAnsweringOnce());
    expect(refusal.code).toBe("session.not_found");
    expect(refusal.detail).toBe("No such session.");
  });

  it("negative control: the fixture really answers differently on a second read", () => {
    const envelope = envelopeAnsweringOnce() as { readonly code: string };
    expect(envelope.code).toBe("session.not_found");
    expect(envelope.code).toBe("session.forbidden");
  });
});
