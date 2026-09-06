// The registered widenings, read off a value that fights back.
//
// The defect this file exists for is the one a caller worked around rather than
// reported: `normalizeWireRejection` rebuilds, the rebuild knew three members, and a
// growth refusal thrown as a `ConsoleRefusalError` came out the other side without the
// ledger that says which operation was called and who owes the wire — so the seat that
// consumed it kept two arms handing the candidate back BY REFERENCE, which is the one
// thing the rebuild exists to prevent.
//
// Two claims, and both are needed. What is registered survives a rebuild, including
// off a candidate whose members are readable exactly once. What is NOT registered does
// not survive whatever the candidate carries — which is what makes carrying anything
// through the rebuild safe, and is the half a "preserve the extra members" fix gets
// wrong by spreading the candidate.

import { describe, expect, it } from "vitest";

import { everyTrapThrows, readableOnce } from "../../../../shared/wire-errors.test-support.js";
import {
  CONSOLE_REFUSAL_EXTENSION_MEMBERS,
  readRefusalExtensions,
  wireRetryExtension,
} from "./refusal-extensions.js";
import { ConsoleRefusalError, refuse, type ConsoleRefusal } from "./refusal.js";
import { normalizeWireRejection } from "./wire-rejection.js";

/**
 * The growth port's refusal, as that port builds one.
 *
 * Written as data rather than imported: `bridge/growth-port/growth-port.ts` sits above this family
 * and `core/` names none of it. What is asserted is the SHAPE that port produces, and
 * the registry's own doc names it as the producer of these three members.
 */
function growthRefusal(): ConsoleRefusal & Record<string, unknown> {
  return {
    ...refuse("growth-port", "wire-unregistered", "Not checked — that wire is not registered."),
    status: "unavailable",
    operationId: "sessionSearch",
    slateRow: "session-search",
    owningDocument: "Spec-016",
  };
}

describe("refusal extensions — the registry is the set, and it is closed", () => {
  it("registers exactly the members the console's producers widen a refusal by", () => {
    // Hand-listed against the table, so a member added or removed is a deliberate edit
    // to a closed set rather than a silent change to what survives a rebuild.
    expect([...CONSOLE_REFUSAL_EXTENSION_MEMBERS].sort()).toStrictEqual([
      "holderParticipantId",
      "operationId",
      "owningDocument",
      "retry",
      "slateRow",
    ]);
  });

  it("reads every registered member a candidate carries", () => {
    expect(readRefusalExtensions(growthRefusal())).toStrictEqual({
      operationId: "sessionSearch",
      slateRow: "session-search",
      owningDocument: "Spec-016",
    });
  });

  it("reads a member that is not the type it is registered as as absent", () => {
    // A hostile or merely broken producer. What must not happen is the value reaching
    // a renderer that will format it.
    expect(
      readRefusalExtensions({
        operationId: 7,
        slateRow: "",
        owningDocument: { toString: () => "gotcha" },
        retry: { afterSeconds: "soon" },
      }),
    ).toStrictEqual({});
  });

  it("answers for a value whose every trap throws, rather than throwing", () => {
    expect(readRefusalExtensions(everyTrapThrows())).toStrictEqual({});
    expect(readRefusalExtensions(undefined)).toStrictEqual({});
    expect(readRefusalExtensions("a thrown string")).toStrictEqual({});
  });

  it("leaves an absent retry bound absent rather than present and undefined", () => {
    // A renderer asks whether the member is THERE. A present `retry: undefined`
    // answers that question wrongly, which is why both producers of an extensions
    // value omit rather than assign.
    const none = wireRetryExtension({ code: "repo.locked", message: "Another node holds it." });
    expect(Object.hasOwn(none, "retry")).toBe(false);
    expect(wireRetryExtension({ retryAfter: 30 })).toStrictEqual({ retry: { afterSeconds: 30 } });
  });
});

describe("refusal extensions — a rebuild carries the registered set and nothing else", () => {
  it("carries a growth refusal's ledger through the normalizer", () => {
    // The defect in terms: this used to answer the three core members and drop the
    // rest, so a surface rendering the refusal could not say who owes the wire.
    const normalized = normalizeWireRejection("collaboration", growthRefusal());

    expect(normalized.operationId).toBe("sessionSearch");
    expect(normalized.slateRow).toBe("session-search");
    expect(normalized.owningDocument).toBe("Spec-016");
    expect(normalized.code).toBe("wire-unregistered");
    expect(normalized.origin).toBe("growth-port");
  });

  it("carries it through an error the refusal was thrown as, too", () => {
    // The path the seat actually takes: a growth outcome raised as a throw so a read
    // body can settle into its failure arm.
    const carried = normalizeWireRejection(
      "collaboration",
      new ConsoleRefusalError(growthRefusal()),
    );

    expect(carried.operationId).toBe("sessionSearch");
    expect(carried.owningDocument).toBe("Spec-016");
  });

  it("drops the union discriminant, so a rebuilt refusal never claims to be an arm", () => {
    // `status` is deliberately unregistered: carried off an unvalidated candidate it
    // would let a rejection spelling `status: "served"` answer as the arm it is not,
    // and the next reader would go looking for the value that arm carries.
    const normalized = normalizeWireRejection("collaboration", growthRefusal());

    expect(Object.hasOwn(normalized, "status")).toBe(false);
    // Both paths, because the ledger travels on both and so would the discriminant.
    const carried = normalizeWireRejection("repos", new ConsoleRefusalError(growthRefusal()));
    expect(Object.hasOwn(carried, "status")).toBe(false);
  });

  it("negative control: an unregistered member does not survive the rebuild", () => {
    // Without this, "carry the extra members" would be satisfied by spreading the
    // candidate — which is the returned-by-reference defect wearing a different
    // spelling, and puts whatever a producer invented on screen.
    const normalized = normalizeWireRejection("repos", {
      ...refuse("repos", "repo.locked", "Another node holds it."),
      authorizationHeader: "Bearer a-token",
      operationId: "sessionSearch",
    });

    expect(normalized.operationId).toBe("sessionSearch");
    expect(Object.hasOwn(normalized, "authorizationHeader")).toBe(false);
  });

  it("reads each registered member exactly once off the candidate", () => {
    // A member whose getter answers once and throws afterwards is what a returned
    // candidate turns into. Every member here is read on the classifying pass and on
    // no later one, so the answer is a plain object of strings already taken.
    const readOnce = readableOnce({
      code: ["wire-unregistered"],
      detail: ["Not checked — that wire is not registered."],
      origin: ["growth-port"],
      operationId: ["sessionSearch"],
      slateRow: ["session-search"],
      owningDocument: ["Spec-016"],
    });

    const normalized = normalizeWireRejection("collaboration", readOnce);

    expect(normalized.operationId).toBe("sessionSearch");
    expect(normalized.owningDocument).toBe("Spec-016");
    // And the answer survives being read again, which the candidate would not.
    expect(normalized.operationId).toBe("sessionSearch");
  });

  it("negative control: the once-readable fixture really does throw on a second read", () => {
    // Without this the case above would be satisfied by a fixture that answered every
    // reading, and would prove nothing about how many readings were taken.
    const readOnce = readableOnce({ operationId: ["sessionSearch"] }) as { operationId: string };
    expect(readOnce.operationId).toBe("sessionSearch");
    expect(() => readOnce.operationId).toThrow();
  });
});
