// The artifacts family's refusal copy: one move per code, the three-way size
// distinction, and which refusal the lookup is asked about.
//
// EVERY CASE HERE FAILS WITHOUT THE TABLE. The recovery slot on this family's refusal
// shapes was empty before it, so a person meeting `artifact.no_access_key` read the
// code and nothing else — and read it as a sign-in problem, which it is not.

import { describe, expect, it } from "vitest";

import { refuse } from "../../core/index.js";
import {
  ARTIFACT_REFUSAL_CODES,
  artifactRefusalRecovery,
  daemonSpokenRefusal,
} from "./artifact-refusal-copy.js";

describe("artifactRefusalRecovery — every registered code has a move", () => {
  it.each(ARTIFACT_REFUSAL_CODES)("answers %s with a non-empty next move", (code) => {
    const recovery = artifactRefusalRecovery(code);
    expect(recovery).toBeDefined();
    expect(recovery?.nextMove.trim().length).toBeGreaterThan(0);
  });

  it("covers the whole wire namespace, so a surface never meets an unanswered one", () => {
    // The count is derived from the tuple rather than written here: this asserts that
    // the tuple and the table are the same set, which is the property a code added to
    // one and not the other breaks.
    for (const code of ARTIFACT_REFUSAL_CODES) {
      expect(artifactRefusalRecovery(code)).toBeDefined();
    }
    expect(new Set(ARTIFACT_REFUSAL_CODES).size).toBe(ARTIFACT_REFUSAL_CODES.length);
  });

  it("negative control: a code this family does not own gets nothing invented for it", () => {
    // The console must not answer a refusal it has no copy for with a generic
    // sentence: the daemon's own detail is then the only true thing on screen.
    expect(artifactRefusalRecovery("session.not_found")).toBeUndefined();
    expect(artifactRefusalRecovery("repo.already_attached")).toBeUndefined();
  });

  it("negative control: an inherited property name is not a registered code", () => {
    // Read through `Object.hasOwn` rather than a bare index, so `toString` and
    // `constructor` are misses rather than functions rendered as recovery copy.
    expect(artifactRefusalRecovery("toString")).toBeUndefined();
    expect(artifactRefusalRecovery("constructor")).toBeUndefined();
  });
});

describe("artifactRefusalRecovery — the size refusal's three enforcement points", () => {
  it("separates the three bounds one code stands for", () => {
    const recovery = artifactRefusalRecovery("artifact.too_large");
    expect(recovery?.distinctions).toHaveLength(3);
    expect(recovery?.distinctions.every((line) => line.trim().length > 0)).toBe(true);
  });

  it("names the reservation bound a person never guesses", () => {
    // The third point fires on a file far below the deployment's cap, so a recovery
    // that offered only "use a smaller file" would be wrong about it.
    const distinctions = artifactRefusalRecovery("artifact.too_large")?.distinctions ?? [];
    expect(distinctions.some((line) => line.includes("declared total"))).toBe(true);
    expect(distinctions.some((line) => line.includes("relay publish cap"))).toBe(true);
  });

  it("negative control: an ordinary code carries no distinctions at all", () => {
    // The list is rendered as a list, so a code that filled it with one restatement of
    // its own move would put a bullet under every refusal in the family.
    expect(artifactRefusalRecovery("artifact.hash_mismatch")?.distinctions).toHaveLength(0);
  });
});

describe("artifactRefusalRecovery — the missing key is not an auth failure", () => {
  it("routes the participant to a publisher re-publish and says the sign-in is fine", () => {
    const recovery = artifactRefusalRecovery("artifact.no_access_key");
    expect(recovery?.nextMove).toContain("re-publishing");
    expect(recovery?.nextMove).toContain("nothing is wrong with your sign-in");
  });

  it("negative control: the fetch refusal says a re-publish would NOT help", () => {
    // The two codes are one status apart and mean opposite things about what to do, so
    // a table that gave them the same move would be worse than no table at all.
    const recovery = artifactRefusalRecovery("artifact.fetch_unauthorized");
    expect(recovery?.nextMove).toContain("would not help");
    expect(recovery?.nextMove).not.toContain("nothing is wrong with your sign-in");
  });
});

describe("daemonSpokenRefusal — the code the daemon spoke, not the one that arrived", () => {
  it("reads through a seam refusal that carries the daemon's own on its cause", () => {
    // The growth port answers a REJECTED call with its own `call-rejected` and the
    // normalized daemon refusal on `cause`. A lookup against the outer code finds
    // nothing, which is every artifact refusal that reaches this console today.
    const cause = refuse("daemon", "artifact.delete_blocked", "Referenced by 2 manifests.");
    const arrived = {
      ...refuse("growth-port", "call-rejected", "artifact CRUD did not answer"),
      cause,
    };
    expect(daemonSpokenRefusal(arrived)).toBe(cause);
    expect(artifactRefusalRecovery(daemonSpokenRefusal(arrived).code)).toBeDefined();
  });

  it("negative control: a refusal with no cause is its own spoken refusal", () => {
    // A served refusal carries the dotted code directly, so unwrapping must be a
    // no-op there rather than an absence the surfaces have to branch on.
    const served = refuse("daemon", "artifact.relay_expired", "Blob is gone.");
    expect(daemonSpokenRefusal(served)).toBe(served);
  });
});
