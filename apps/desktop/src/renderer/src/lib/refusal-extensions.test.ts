// The registered extensions, read off hostile values. Registered members survive the rebuild in
// `normalizeWireRejection`, even off a candidate readable only once; unregistered ones never do,
// which rules out fixing this by spreading the candidate.

import { describe, expect, it } from "vitest";

import { everyTrapThrows, readableOnce } from "./wire-errors.test-support.js";
import {
  REFUSAL_EXTENSION_MEMBERS,
  readRefusalExtensions,
  wireRetryExtension,
} from "./refusal-extensions.js";
import { RefusalError, refuse, type Refusal } from "./refusal.js";
import { normalizeWireRejection } from "./wire-rejection.js";

/** A refusal widened by both registered members, plus a member that is not registered. */
function widenedRefusal(): Refusal & Record<string, unknown> {
  return {
    ...refuse("sessions", "session.goal_delivery_failed", "Not delivered to every agent."),
    status: "unavailable",
    retry: { afterSeconds: 30 },
    failedBindingIds: ["binding-a"],
  };
}

describe("refusal extensions — the registry is the set, and it is closed", () => {
  it("registers exactly the members the console's producers widen a refusal by", () => {
    // Hand-listed, so changing the closed set is a deliberate edit.
    expect([...REFUSAL_EXTENSION_MEMBERS].sort()).toStrictEqual(["failedBindingIds", "retry"]);
  });

  it("reads every registered member a candidate carries", () => {
    expect(readRefusalExtensions(widenedRefusal())).toStrictEqual({
      retry: { afterSeconds: 30 },
      failedBindingIds: ["binding-a"],
    });
  });

  it("reads a member that is not the type it is registered as as absent", () => {
    // A hostile or broken producer; the value must not reach a renderer that would format it.
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
    // These ride on `data.fields` for `session.goal_delivery_failed`; the goal card names them.
    expect(readRefusalExtensions({ failedBindingIds: ["binding-a", "binding-b"] })).toStrictEqual({
      failedBindingIds: ["binding-a", "binding-b"],
    });
  });

  it("drops the elements it cannot read and keeps the ones it can", () => {
    // The component renders one figure per element, so an unreadable one would render empty.
    expect(
      readRefusalExtensions({ failedBindingIds: ["binding-a", "", 7, null, "binding-b"] }),
    ).toStrictEqual({ failedBindingIds: ["binding-a", "binding-b"] });
  });

  it("answers absent rather than empty when no element survives", () => {
    // An empty list would claim the daemon named no failing binding.
    expect(readRefusalExtensions({ failedBindingIds: [] })).toStrictEqual({});
    expect(readRefusalExtensions({ failedBindingIds: [7, null] })).toStrictEqual({});
    expect(readRefusalExtensions({ failedBindingIds: "binding-a" })).toStrictEqual({});
  });

  it("leaves an absent retry bound absent rather than present and undefined", () => {
    // Renderers ask whether the member is present, so a `retry: undefined` would answer wrongly.
    const none = wireRetryExtension({ code: "repo.locked", message: "Another node holds it." });
    expect(Object.hasOwn(none, "retry")).toBe(false);
    expect(wireRetryExtension({ retryAfter: 30 })).toStrictEqual({ retry: { afterSeconds: 30 } });
  });
});

describe("refusal extensions — a rebuild carries the registered set and nothing else", () => {
  it("carries a refusal's registered members through the normalizer", () => {
    // A rebuild of only the three core members would leave the component unable to name the
    // failed bindings.
    const normalized = normalizeWireRejection("sessions", widenedRefusal());

    expect(normalized.failedBindingIds).toStrictEqual(["binding-a"]);
    expect(normalized.retry).toStrictEqual({ afterSeconds: 30 });
    expect(normalized.code).toBe("session.goal_delivery_failed");
    expect(normalized.origin).toBe("sessions");
  });

  it("carries it through an error the refusal was thrown as, too", () => {
    // A refusal raised as a throw, as a read body does.
    const carried = normalizeWireRejection("sessions", new RefusalError(widenedRefusal()));

    expect(carried.failedBindingIds).toStrictEqual(["binding-a"]);
    expect(carried.retry).toStrictEqual({ afterSeconds: 30 });
  });

  it("drops the union discriminant, so a rebuilt refusal never claims to be an arm", () => {
    // `status` is unregistered: carried off an unvalidated candidate it would let a rejection
    // spelling `status: "served"` pass as an arm it is not.
    const normalized = normalizeWireRejection("sessions", widenedRefusal());

    expect(Object.hasOwn(normalized, "status")).toBe(false);
    // Both paths, because the extensions travel on both and so would the unregistered member.
    const carried = normalizeWireRejection("repos", new RefusalError(widenedRefusal()));
    expect(Object.hasOwn(carried, "status")).toBe(false);
  });

  it("negative control: an unregistered member does not survive the rebuild", () => {
    // Without this, spreading the candidate would satisfy the cases above and put whatever a
    // producer invented on screen.
    const normalized = normalizeWireRejection("repos", {
      ...refuse("repos", "repo.locked", "Another node holds it."),
      authorizationHeader: "Bearer a-token",
      failedBindingIds: ["binding-a"],
    });

    expect(normalized.failedBindingIds).toStrictEqual(["binding-a"]);
    expect(Object.hasOwn(normalized, "authorizationHeader")).toBe(false);
  });

  it("reads each registered member exactly once off the candidate", () => {
    // Every member is read once, on the classifying pass, so the answer is a plain object of
    // strings already taken even if the getter throws afterwards.
    const readOnce = readableOnce({
      code: ["session.goal_delivery_failed"],
      detail: ["Not delivered to every agent."],
      origin: ["sessions"],
      failedBindingIds: [["binding-a"]],
    });

    const normalized = normalizeWireRejection("sessions", readOnce);

    expect(normalized.failedBindingIds).toStrictEqual(["binding-a"]);
    // The answer survives being read again; the candidate would not.
    expect(normalized.failedBindingIds).toStrictEqual(["binding-a"]);
  });

  it("negative control: the once-readable fixture really does throw on a second read", () => {
    // Without this, a fixture answering every reading would satisfy the case above.
    const readOnce = readableOnce({ failedBindingIds: [["binding-a"]] }) as {
      failedBindingIds: readonly string[];
    };
    expect(readOnce.failedBindingIds).toStrictEqual(["binding-a"]);
    expect(() => readOnce.failedBindingIds).toThrow();
  });
});
