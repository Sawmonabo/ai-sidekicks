// The registered widenings, read off a value that fights back.
//
// The defect this file exists for is the one a caller worked around rather than
// reported: `normalizeWireRejection` rebuilds, the rebuild knew three members, and a
// refusal thrown as a `ConsoleRefusalError` came out the other side without the members
// its producer widened it by — so a caller kept arms handing the candidate back BY
// REFERENCE, which is the one thing the rebuild exists to prevent.
//
// Two claims, and both are needed. What is registered survives a rebuild, including
// off a candidate whose members are readable exactly once. What is NOT registered does
// not survive whatever the candidate carries — which is what makes carrying anything
// through the rebuild safe, and is the half a "preserve the extra members" fix gets
// wrong by spreading the candidate.

import { describe, expect, it } from "vitest";

import { everyTrapThrows, readableOnce } from "./wire-errors.test-support.js";
import {
  REFUSAL_EXTENSION_MEMBERS,
  readRefusalExtensions,
  wireRetryExtension,
} from "./refusal-extensions.js";
import { ConsoleRefusalError, refuse, type ConsoleRefusal } from "./refusal.js";
import { normalizeWireRejection } from "./wire-rejection.js";

/**
 * A refusal widened by both registered members, plus a discriminant that is not one.
 */
function widenedRefusal(): ConsoleRefusal & Record<string, unknown> {
  return {
    ...refuse("sessions", "session.goal_delivery_failed", "Not delivered to every agent."),
    status: "unavailable",
    retry: { afterSeconds: 30 },
    failedBindingIds: ["binding-a"],
  };
}

describe("refusal extensions — the registry is the set, and it is closed", () => {
  it("registers exactly the members the console's producers widen a refusal by", () => {
    // Hand-listed against the table, so a member added or removed is a deliberate edit
    // to a closed set rather than a silent change to what survives a rebuild.
    expect([...REFUSAL_EXTENSION_MEMBERS].sort()).toStrictEqual(["failedBindingIds", "retry"]);
  });

  it("reads every registered member a candidate carries", () => {
    expect(readRefusalExtensions(widenedRefusal())).toStrictEqual({
      retry: { afterSeconds: 30 },
      failedBindingIds: ["binding-a"],
    });
  });

  it("reads a member that is not the type it is registered as as absent", () => {
    // A hostile or merely broken producer. What must not happen is the value reaching
    // a renderer that will format it.
    expect(
      readRefusalExtensions({
        failedBindingIds: { toString: () => "gotcha" },
        retry: { afterSeconds: "soon" },
      }),
    ).toStrictEqual({});
  });

  it("answers for a value whose every trap throws, rather than throwing", () => {
    expect(readRefusalExtensions(everyTrapThrows())).toStrictEqual({});
    expect(readRefusalExtensions(undefined)).toStrictEqual({});
    expect(readRefusalExtensions("a thrown string")).toStrictEqual({});
  });

  it("reads the failed bindings a goal-delivery refusal names", () => {
    // `error-contracts.md` puts these on `data.fields` for
    // `session.goal_delivery_failed`, and the goal card names them beside the remedy.
    expect(readRefusalExtensions({ failedBindingIds: ["binding-a", "binding-b"] })).toStrictEqual({
      failedBindingIds: ["binding-a", "binding-b"],
    });
  });

  it("drops the elements it cannot read and keeps the ones it can", () => {
    // A row naming nobody is worse than a shorter list: the surface renders one
    // figure per element, and an unreadable element would render an empty figure.
    expect(
      readRefusalExtensions({ failedBindingIds: ["binding-a", "", 7, null, "binding-b"] }),
    ).toStrictEqual({ failedBindingIds: ["binding-a", "binding-b"] });
  });

  it("answers absent rather than empty when no element survives", () => {
    // An EMPTY list would say the daemon named no failing binding, which is a
    // different fact from its having named none this console could read.
    expect(readRefusalExtensions({ failedBindingIds: [] })).toStrictEqual({});
    expect(readRefusalExtensions({ failedBindingIds: [7, null] })).toStrictEqual({});
    expect(readRefusalExtensions({ failedBindingIds: "binding-a" })).toStrictEqual({});
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
  it("carries a refusal's registered members through the normalizer", () => {
    // The defect in terms: this used to answer the three core members and drop the
    // rest, so a surface rendering the refusal could not name the failed bindings.
    const normalized = normalizeWireRejection("sessions", widenedRefusal());

    expect(normalized.failedBindingIds).toStrictEqual(["binding-a"]);
    expect(normalized.retry).toStrictEqual({ afterSeconds: 30 });
    expect(normalized.code).toBe("session.goal_delivery_failed");
    expect(normalized.origin).toBe("sessions");
  });

  it("carries it through an error the refusal was thrown as, too", () => {
    // A refusal raised as a throw so a read body can settle into its failure arm.
    const carried = normalizeWireRejection("sessions", new ConsoleRefusalError(widenedRefusal()));

    expect(carried.failedBindingIds).toStrictEqual(["binding-a"]);
    expect(carried.retry).toStrictEqual({ afterSeconds: 30 });
  });

  it("drops the union discriminant, so a rebuilt refusal never claims to be an arm", () => {
    // `status` is deliberately unregistered: carried off an unvalidated candidate it
    // would let a rejection spelling `status: "served"` answer as the arm it is not,
    // and the next reader would go looking for the value that arm carries.
    const normalized = normalizeWireRejection("sessions", widenedRefusal());

    expect(Object.hasOwn(normalized, "status")).toBe(false);
    // Both paths, because the extensions travel on both and so would the discriminant.
    const carried = normalizeWireRejection("repos", new ConsoleRefusalError(widenedRefusal()));
    expect(Object.hasOwn(carried, "status")).toBe(false);
  });

  it("negative control: an unregistered member does not survive the rebuild", () => {
    // Without this, "carry the extra members" would be satisfied by spreading the
    // candidate — which is the returned-by-reference defect wearing a different
    // spelling, and puts whatever a producer invented on screen.
    const normalized = normalizeWireRejection("repos", {
      ...refuse("repos", "repo.locked", "Another node holds it."),
      authorizationHeader: "Bearer a-token",
      failedBindingIds: ["binding-a"],
    });

    expect(normalized.failedBindingIds).toStrictEqual(["binding-a"]);
    expect(Object.hasOwn(normalized, "authorizationHeader")).toBe(false);
  });

  it("reads each registered member exactly once off the candidate", () => {
    // A member whose getter answers once and throws afterwards is what a returned
    // candidate turns into. Every member here is read on the classifying pass and on
    // no later one, so the answer is a plain object of strings already taken.
    const readOnce = readableOnce({
      code: ["session.goal_delivery_failed"],
      detail: ["Not delivered to every agent."],
      origin: ["sessions"],
      failedBindingIds: [["binding-a"]],
    });

    const normalized = normalizeWireRejection("sessions", readOnce);

    expect(normalized.failedBindingIds).toStrictEqual(["binding-a"]);
    // And the answer survives being read again, which the candidate would not.
    expect(normalized.failedBindingIds).toStrictEqual(["binding-a"]);
  });

  it("negative control: the once-readable fixture really does throw on a second read", () => {
    // Without this the case above would be satisfied by a fixture that answered every
    // reading, and would prove nothing about how many readings were taken.
    const readOnce = readableOnce({ failedBindingIds: [["binding-a"]] }) as {
      failedBindingIds: readonly string[];
    };
    expect(readOnce.failedBindingIds).toStrictEqual(["binding-a"]);
    expect(() => readOnce.failedBindingIds).toThrow();
  });
});
