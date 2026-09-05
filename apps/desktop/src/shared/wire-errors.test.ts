// The cross-process leaf, against the values it exists to survive.
//
// Every function here is on a failure path by construction — the argument is a
// rejected promise's value or an `unknown` prop, which is to say whatever a producer
// threw. So the interesting cases are not the well-formed envelopes; they are the
// values that fight back, and each one below carries its own negative control: the
// raw operation the guarded reading replaced, asserted to throw on the same value.
//
// This suite belongs to the `main-unit` project, which is what reaches
// `src/shared/**` — the subtree both processes compile.

import { describe, expect, it } from "vitest";

import {
  isErrorInstance,
  isPropertyContainer,
  lossyStringify,
  readGuardedProperty,
  readWireErrorEnvelope,
  readWireErrorEnvelopeWithCode,
  wireRejectionToError,
} from "./wire-errors.js";
import {
  everyTrapThrows,
  nullPrototypeValue,
  readableOnce,
  revokedProxy,
} from "./wire-errors.test-support.js";

/** The envelope this suite reads, scripted so a second reading of either member throws. */
function readableOnceEnvelope(): unknown {
  return readableOnce({
    code: ["repo.not_found"],
    message: ["That repository is not mounted."],
  });
}

describe("readGuardedProperty — absent and unreadable answer the same", () => {
  it("answers undefined for a primitive, for null, and for a missing member", () => {
    expect(readGuardedProperty(null, "code")).toBeUndefined();
    expect(readGuardedProperty(7, "code")).toBeUndefined();
    expect(readGuardedProperty({}, "code")).toBeUndefined();
  });

  it("answers undefined where the read itself throws", () => {
    const proxy = revokedProxy();
    expect(() => (proxy as { code: unknown }).code).toThrow();
    expect(readGuardedProperty(proxy, "code")).toBeUndefined();
  });

  it("reads a member off a function, which is a property container too", () => {
    const carrier = Object.assign(() => undefined, { code: "repo.not_found" });
    expect(readGuardedProperty(carrier, "code")).toBe("repo.not_found");
  });
});

describe("isPropertyContainer — what can carry a member at all", () => {
  it("accepts objects and functions, and rejects null and every primitive", () => {
    expect(isPropertyContainer({})).toBe(true);
    expect(isPropertyContainer([])).toBe(true);
    // A function is a property container too — the clause a second copy of this
    // predicate loses, and the one that admits a null-prototype function envelope.
    expect(isPropertyContainer(() => undefined)).toBe(true);
    expect(isPropertyContainer(nullPrototypeValue())).toBe(true);
    expect(isPropertyContainer(null)).toBe(false);
    expect(isPropertyContainer(undefined)).toBe(false);
    expect(isPropertyContainer("repo.not_found")).toBe(false);
    expect(isPropertyContainer(7)).toBe(false);
    expect(isPropertyContainer(Symbol("thrown"))).toBe(false);
  });

  it("asks nothing OF the value, so a hostile one answers as any object does", () => {
    // `typeof` runs no trap and no getter, which is what lets the guarded reader
    // pre-check a revoked Proxy before touching it.
    expect(isPropertyContainer(revokedProxy())).toBe(true);
    expect(isPropertyContainer(everyTrapThrows())).toBe(true);
  });
});

describe("isErrorInstance — the one prototype question, asked safely", () => {
  it("answers the ordinary cases exactly as `instanceof` does", () => {
    expect(isErrorInstance(new Error("boom"))).toBe(true);
    expect(isErrorInstance(new TypeError("boom"))).toBe(true);
    expect(isErrorInstance({ message: "boom" })).toBe(false);
    expect(isErrorInstance(undefined)).toBe(false);
    expect(isErrorInstance("boom")).toBe(false);
  });

  it("answers false for a revoked Proxy, where `instanceof` throws", () => {
    const proxy = revokedProxy();
    expect(() => proxy instanceof Error).toThrow();
    expect(isErrorInstance(proxy)).toBe(false);
  });

  it("answers false where a getPrototypeOf trap throws", () => {
    const hostile = everyTrapThrows();
    expect(() => hostile instanceof Error).toThrow();
    expect(isErrorInstance(hostile)).toBe(false);
  });
});

describe("readWireErrorEnvelope — one read per member, whatever the answer", () => {
  it("reads a plain envelope and an Error subclass carrying the code alike", () => {
    expect(readWireErrorEnvelope({ code: "repo.not_found", message: "gone" })).toStrictEqual({
      code: "repo.not_found",
      message: "gone",
    });
    const sdkError = Object.assign(new Error("Another node holds it."), {
      code: "runtimenode.attach_conflict",
    });
    expect(readWireErrorEnvelope(sdkError)).toStrictEqual({
      code: "runtimenode.attach_conflict",
      message: "Another node holds it.",
    });
  });

  it("answers undefined for a numeric code, a missing message, and a hostile value", () => {
    expect(readWireErrorEnvelope({ code: -32603, message: "Internal error" })).toBeUndefined();
    expect(readWireErrorEnvelope({ code: "repo.not_found" })).toBeUndefined();
    expect(readWireErrorEnvelope(revokedProxy())).toBeUndefined();
  });

  it("hands back an object of its own, so the candidate is never read again", () => {
    const candidate = { code: "repo.not_found", message: "gone" };
    const envelope = readWireErrorEnvelope(candidate);
    expect(envelope).toStrictEqual(candidate);
    expect(envelope).not.toBe(candidate);
  });
});

describe("readWireErrorEnvelopeWithCode — the discriminant costs no second read", () => {
  it("answers a snapshot on a match and undefined on a miss", () => {
    expect(
      readWireErrorEnvelopeWithCode({ code: "repo.not_found", message: "gone" }, "repo.not_found"),
    ).toStrictEqual({ code: "repo.not_found", message: "gone" });
    expect(
      readWireErrorEnvelopeWithCode({ code: "repo.not_found", message: "gone" }, "repo.locked"),
    ).toBeUndefined();
  });

  it("hands back an object of its own, so the candidate is never read again", () => {
    // The claim that makes this a reader rather than a predicate: a narrowing would
    // have handed the caller the candidate, and the caller's own `.code` would be a
    // second access on a value nobody validated.
    const candidate = { code: "repo.not_found", message: "gone" };
    const matched = readWireErrorEnvelopeWithCode(candidate, "repo.not_found");
    expect(matched).toStrictEqual(candidate);
    expect(matched).not.toBe(candidate);
  });

  it("answers a value whose members are readable once, and stays readable itself", () => {
    // The negative control is the shape itself: this candidate answers each member
    // exactly once, so any second read — the discriminant's, or a caller's — throws.
    // The snapshot answers as many times as a render asks.
    const matched = readWireErrorEnvelopeWithCode(readableOnceEnvelope(), "repo.not_found");
    expect(matched?.code).toBe("repo.not_found");
    expect(matched?.code).toBe("repo.not_found");
    expect(matched?.message).toBe("That repository is not mounted.");
    const candidate = readableOnceEnvelope() as { readonly code: string };
    expect(candidate.code).toBe("repo.not_found");
    expect(() => candidate.code).toThrow();
  });

  it("answers undefined for a value whose every trap throws", () => {
    expect(readWireErrorEnvelopeWithCode(everyTrapThrows(), "repo.not_found")).toBeUndefined();
  });
});

describe("wireRejectionToError — renders the value it is handed, and never throws", () => {
  it("rebuilds a typed envelope with the wire code as the error name", () => {
    const rendered = wireRejectionToError({ code: "repo.not_found", message: "gone" });
    expect(rendered.name).toBe("repo.not_found");
    expect(rendered.message).toBe("gone");
  });

  it("passes an ordinary Error through unchanged", () => {
    const thrown = new Error("socket closed");
    expect(wireRejectionToError(thrown)).toBe(thrown);
  });

  it("survives a value whose members are readable once", () => {
    const rendered = wireRejectionToError(readableOnceEnvelope());
    expect(rendered.name).toBe("repo.not_found");
    expect(rendered.message).toBe("That repository is not mounted.");
  });

  it.each([[true], [false]])(
    "survives a revoked Proxy with total: %s, which `instanceof` throws on",
    (total) => {
      const proxy = revokedProxy();
      expect(() => proxy instanceof Error).toThrow();
      const rendered = wireRejectionToError(proxy, { total });
      expect(rendered).toBeInstanceOf(Error);
      expect(rendered.message).toBe("[unrepresentable value]");
    },
  );

  it("survives a null-prototype object on both arms, where String(...) throws", () => {
    const value = nullPrototypeValue();
    expect(() => String(value)).toThrow();
    expect(wireRejectionToError(value, { total: true }).message).toBe("[unrepresentable value]");
    // The backstop, not the mechanism: `total: false` still ATTEMPTS the bare wrap —
    // which is what the option chooses — and no longer makes the failure a throw.
    expect(wireRejectionToError(value).message).toBe("[unrepresentable value]");
  });

  it("keeps the bare wrap for the ordinary values total: false is about", () => {
    expect(wireRejectionToError("socket closed").message).toBe("socket closed");
    expect(wireRejectionToError(undefined).message).toBe("undefined");
    expect(lossyStringify(undefined)).toBe("undefined");
  });
});
