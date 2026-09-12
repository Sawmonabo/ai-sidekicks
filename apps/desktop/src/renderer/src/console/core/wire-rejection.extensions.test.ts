// What a rejection's registered EXTENSIONS read, off both positions the wire uses.
//
// Split from `wire-rejection.test.ts`, which owns two other rules over the same
// function: that the arms keep the refusing side's own code, and that it is total
// against a value that fights back. This is the rule that grows: every reader
// `refusal-extensions.ts` registers is a member that reaches a surface BECAUSE it was
// registered and never because the wire carried it, and every one of them can arrive on
// either the JSON-RPC `data.fields` payload or the flat envelope.
//
// SO EVERY CASE HERE HAS A NEGATIVE CONTROL BESIDE IT, and they are the point rather
// than the ceremony: a sibling member on the same payload that no reader is registered
// for must NOT survive, and an envelope naming nothing must leave the member absent
// rather than present-and-empty — "retry immediately" and "the refusing side said
// nothing about retrying" are different facts.

import { describe, expect, it } from "vitest";

import { readRefusalExtensions } from "./refusal-extensions.js";
import { normalizeWireRejection } from "./wire-rejection.js";

describe("normalizeWireRejection — the retry bound the wire registered", () => {
  it("reads seconds and a reset instant off a JSON-RPC fields payload", () => {
    const refusal = normalizeWireRejection("channels", {
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
      normalizeWireRejection("channels", {
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
      normalizeWireRejection("channels", {
        code: "ratelimit.exceeded",
        message: "…",
        resetAt: "2026-02-30T12:00:00Z",
      }).retry,
    ).toBeUndefined();
  });

  it("ignores a negative or non-finite second count", () => {
    expect(
      normalizeWireRejection("channels", { code: "x", message: "y", retryAfter: -1 }).retry,
    ).toBeUndefined();
    expect(
      normalizeWireRejection("channels", { code: "x", message: "y", retryAfter: "soon" }).retry,
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

describe("normalizeWireRejection — the manifests a blocked delete names", () => {
  it("reads the details off `data.fields` on the JSON-RPC arm", () => {
    const refusal = normalizeWireRejection("repos", {
      code: -32603,
      message: "Delete the derivatives first, or keep the source.",
      data: {
        type: "artifact.delete_blocked",
        fields: {
          referencingArtifactIds: ["artifact-02", "artifact-03"],
          referencingArtifactTotal: 51,
        },
      },
    });
    expect(refusal.code).toBe("artifact.delete_blocked");
    expect(readRefusalExtensions(refusal).referencingArtifacts).toStrictEqual({
      ids: ["artifact-02", "artifact-03"],
      total: 51,
    });
  });

  it("reads them off `details` on the flat envelope arm", () => {
    // The two positions the corpus registers for one shape. A reader bound to one of
    // them would drop the whole list on the other transport.
    const refusal = normalizeWireRejection("repos", {
      code: "artifact.delete_blocked",
      message: "Delete the derivatives first, or keep the source.",
      details: { referencingArtifactIds: ["artifact-02"], referencingArtifactTotal: 1 },
    });
    expect(readRefusalExtensions(refusal).referencingArtifacts).toStrictEqual({
      ids: ["artifact-02"],
      total: 1,
    });
  });

  it("negative control: an envelope naming no referencing manifest carries no reading", () => {
    const refusal = normalizeWireRejection("repos", {
      code: "artifact.delete_forbidden",
      message: "The caller may not delete this artifact.",
      details: { role: "viewer" },
    });
    expect(Object.hasOwn(refusal, "referencingArtifacts")).toBe(false);
  });
});
