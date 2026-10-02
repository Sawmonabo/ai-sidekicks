// The registered extensions, read off hostile values. Registered members survive the rebuild in
// `normalizeWireRejection`; unregistered ones never do, which rules out fixing this by spreading
// the candidate.

import { describe, expect, it } from "vitest";

import { everyTrapThrows } from "./wire-errors.test-support.js";
import { readRefusalExtensions } from "./refusal-extensions.js";
import { RefusalError, refuse, type Refusal } from "./refusal.js";
import { normalizeWireRejection } from "./wire-rejection.js";

/** A refusal widened by the registered member, plus a member that is not registered. */
function widenedRefusal(): Refusal & Record<string, unknown> {
  return {
    ...refuse("sessions", "session.not_found", "The session is gone."),
    status: "unavailable",
    retry: { afterSeconds: 30 },
  };
}

describe("refusal extensions — read off a value that fights back", () => {
  it("answers for a value whose every trap throws, rather than throwing", () => {
    expect(readRefusalExtensions(everyTrapThrows())).toStrictEqual({});
    expect(readRefusalExtensions(undefined)).toStrictEqual({});
    expect(readRefusalExtensions("a thrown string")).toStrictEqual({});
  });
});

describe("refusal extensions — a rebuild carries the registered set and nothing else", () => {
  it("drops the union discriminant, so a rebuilt refusal never claims to be an arm", () => {
    // `status` is unregistered: carried off an unvalidated candidate it would let a rejection
    // spelling `status: "served"` pass as an arm it is not.
    const normalized = normalizeWireRejection("sessions", widenedRefusal());

    expect(Object.hasOwn(normalized, "status")).toBe(false);
    // Both paths, because the extensions travel on both and so would the unregistered member.
    const carried = normalizeWireRejection("repos", new RefusalError(widenedRefusal()));
    expect(Object.hasOwn(carried, "status")).toBe(false);
  });

  it("keeps an unregistered member off the rebuilt refusal", () => {
    // Spreading the candidate would put whatever a producer invented on screen.
    const normalized = normalizeWireRejection("repos", {
      ...refuse("repos", "repo.locked", "The repository is locked."),
      authorizationHeader: "Bearer a-token",
      retry: { afterSeconds: 30 },
    });

    expect(normalized.retry).toStrictEqual({ afterSeconds: 30 });
    expect(Object.hasOwn(normalized, "authorizationHeader")).toBe(false);
  });
});
