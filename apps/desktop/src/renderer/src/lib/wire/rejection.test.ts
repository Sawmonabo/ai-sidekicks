// The arms keep the refusing side's own code, and the function is total against hostile values.
// Totality matters because `String(...)` on a null-prototype rejection would throw inside the
// `catch` that clears a busy control, leaving it busy forever.

import { describe, expect, it } from "vitest";

import { UNREPRESENTABLE_VALUE_TEXT } from "./errors.js";
import { everyTrapThrows, nullPrototypeValue } from "./errors.test-support.js";
import { RefusalError, isRefusal, refuse } from "../refusal/refusal.js";
import { normalizeWireRejection } from "./rejection.js";

describe("normalizeWireRejection — the refusing side's own code survives", () => {
  it("keeps a refusal's own author, code and sentence, on an object of its own", () => {
    const original = refuse("sessions", "session.not_found", "No session answers to this id.");
    const normalized = normalizeWireRejection("repos", original);
    expect(normalized).toStrictEqual(original);
    // Rebuilt, not returned: handing the candidate back would let a hostile one reach the renderer.
    expect(normalized).not.toBe(original);
  });

  it("unwraps a carried refusal structurally, not by prototype", () => {
    const carried = refuse("persistence", "quota-exceeded", "The store is full.");
    expect(normalizeWireRejection("repos", new RefusalError(carried))).toStrictEqual(carried);
    // Control: a plain object carrying the member unwraps identically. A value from another
    // realm or a structured clone has no prototype chain, so `instanceof` would drop its code.
    expect(normalizeWireRejection("repos", { refusal: carried })).toStrictEqual(carried);
  });

  it("takes the dotted project code off a JSON-RPC error envelope", () => {
    // `JsonRpcRemoteError` carries the JSON-RPC numeric as `code` and the dotted code at
    // `data.type`, which callers must discriminate on. The negative control below reads `code`.
    const remote = Object.assign(new Error("That session is not on this node."), {
      code: -32603,
      data: { type: "session.not_found" },
    });
    const refusal = normalizeWireRejection("sessions", remote);
    expect(refusal.code).toBe("session.not_found");
    expect(refusal.detail).toBe("That session is not on this node.");
    expect(refusal.origin).toBe("sessions");
    expect(refusal.code).not.toBe("sessions-call-failed");
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
    expect(isRefusal(refusal)).toBe(true);
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

  it("answers a refusal for a Proxy whose every trap throws, prototype included", () => {
    const hostile = everyTrapThrows();
    expect(() => hostile instanceof Error).toThrow();
    const refusal = normalizeWireRejection("browser", hostile);
    expect(refusal.code).toBe("browser-call-failed");
    expect(refusal.origin).toBe("browser");
    expect(typeof refusal.detail).toBe("string");
  });
});

// What may stand in the detail sentence: never the refused value, which may be user content. A
// rejection's members can be request values, paths or tokens, so no arm serializes it. Every case
// plants a request value the stringifier would disclose; without that, "the detail is the
// constant" would pass on a fixture with nothing to leak.
describe("normalizeWireRejection — the detail is a sentence, never the rejection", () => {
  /**
   * What a malformed producer put on the wire beside a good code. `data.fields` legitimately holds
   * request values, and the `toString` is what a serializing arm would reach.
   */
  const PLANTED_REQUEST_VALUE = "/Users/someone/private-notes";

  /** A JSON-RPC envelope carrying a dotted code, no readable sentence, and content. */
  function envelopeCarryingContent(): unknown {
    return {
      code: -32603,
      message: { notAString: true },
      data: { type: "repo.not_found", fields: { path: PLANTED_REQUEST_VALUE } },
      toString(): string {
        return `repo read failed for ${PLANTED_REQUEST_VALUE}`;
      },
    };
  }

  it("keeps the dotted code and renders the constant rather than the envelope", () => {
    const refusal = normalizeWireRejection("repos", envelopeCarryingContent());
    expect(refusal.code).toBe("repo.not_found");
    expect(refusal.detail).toBe(UNREPRESENTABLE_VALUE_TEXT);
    // The whole answer, not only the sentence: no rejection member reaches the renderer.
    expect(JSON.stringify(refusal)).not.toContain(PLANTED_REQUEST_VALUE);
  });

  it("refuses to serialize a structure on the terminal arm either", () => {
    const rejection = {
      requestedPath: PLANTED_REQUEST_VALUE,
      toString(): string {
        return `the call failed for ${PLANTED_REQUEST_VALUE}`;
      },
    };
    const refusal = normalizeWireRejection("repos", rejection);
    expect(refusal.code).toBe("repos-call-failed");
    expect(refusal.detail).toBe(UNREPRESENTABLE_VALUE_TEXT);
  });

  it("still lets prose a producer wrote reach the detail", () => {
    // Without this, an arm refusing every sentence would satisfy the cases above.
    expect(normalizeWireRejection("repos", new Error("The mount is gone.")).detail).toBe(
      "The mount is gone.",
    );
    expect(normalizeWireRejection("repos", "the socket closed").detail).toBe("the socket closed");
    expect(
      normalizeWireRejection("repos", { code: "repo.locked", message: "Another node holds it." })
        .detail,
    ).toBe("Another node holds it.");
  });
});
