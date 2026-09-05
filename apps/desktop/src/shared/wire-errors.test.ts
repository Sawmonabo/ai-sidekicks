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
  isWireErrorEnvelope,
  isWireErrorEnvelopeWithCode,
  lossyStringify,
  readGuardedProperty,
  readWireErrorEnvelope,
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

describe("isWireErrorEnvelopeWithCode — the discriminant costs no second read", () => {
  it("matches on the code the reader returned", () => {
    expect(
      isWireErrorEnvelopeWithCode({ code: "repo.not_found", message: "gone" }, "repo.not_found"),
    ).toBe(true);
    expect(
      isWireErrorEnvelopeWithCode({ code: "repo.not_found", message: "gone" }, "repo.locked"),
    ).toBe(false);
    expect(isWireErrorEnvelope({ code: "repo.not_found", message: "gone" })).toBe(true);
  });

  it("answers a value whose members are readable once, where a second read throws", () => {
    // The negative control is the shape itself: the predicate used to read `.code`
    // again after the guard had already read it, so this value threw inside the
    // discriminant. Two calls here, four member reads in the old shape, one each now.
    expect(isWireErrorEnvelopeWithCode(readableOnceEnvelope(), "repo.not_found")).toBe(true);
    const candidate = readableOnceEnvelope() as { readonly code: string };
    expect(candidate.code).toBe("repo.not_found");
    expect(() => candidate.code).toThrow();
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
