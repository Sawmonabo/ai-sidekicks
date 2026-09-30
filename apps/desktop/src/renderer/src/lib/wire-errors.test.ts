// The wire-error readers against values that fight back. Every function here runs on a failure
// path, so each case carries a negative control: the raw operation the guarded read replaced,
// asserted to throw on the same value.

import { describe, expect, it } from "vitest";

import {
  readGuardedProperty,
  readWireErrorEnvelopeWithCode,
  wireRejectionToError,
} from "./wire-errors.js";
import { everyTrapThrows, nullPrototypeValue } from "./wire-errors.test-support.js";

/** A Proxy with no target left. Every prototype and property question throws. */
function revokedProxy(): unknown {
  const revocable = Proxy.revocable({}, {});
  revocable.revoke();
  return revocable.proxy;
}

describe("readGuardedProperty — absent and unreadable answer the same", () => {
  it("answers undefined where the read itself throws", () => {
    const proxy = revokedProxy();
    expect(() => (proxy as { code: unknown }).code).toThrow();
    expect(readGuardedProperty(proxy, "code")).toBeUndefined();
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

  it("answers undefined for a value whose every trap throws", () => {
    expect(readWireErrorEnvelopeWithCode(everyTrapThrows(), "repo.not_found")).toBeUndefined();
  });
});

describe("wireRejectionToError — renders the value it is handed, and never throws", () => {
  it("survives a null-prototype object on both arms, where String(...) throws", () => {
    const value = nullPrototypeValue();
    expect(() => String(value)).toThrow();
    expect(wireRejectionToError(value, { total: true }).message).toBe("[unrepresentable value]");
    // Backstop: `total: false` still attempts the bare wrap but does not let the failure throw.
    expect(wireRejectionToError(value).message).toBe("[unrepresentable value]");
  });
});
