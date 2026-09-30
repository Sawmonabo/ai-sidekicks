// The registered extensions, read off both wire positions (JSON-RPC `data.fields` and the flat
// envelope). Each case has a negative control: an unregistered sibling member must not survive,
// and an envelope naming nothing leaves the member absent, not present-and-empty.

import { describe, expect, it } from "vitest";

import { readRefusalExtensions } from "./refusal-extensions.js";
import { normalizeWireRejection } from "./wire-rejection.js";

describe("normalizeWireRejection — the retry bound the wire registered", () => {
  it("reads seconds and a reset instant off a JSON-RPC fields payload", () => {
    const refusal = normalizeWireRejection("sessions", {
      code: -32603,
      message: "Too many requests.",
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
      normalizeWireRejection("sessions", {
        code: "ratelimit.exceeded",
        message: "Slow down.",
        retryAfter: 5,
      }).retry,
    ).toStrictEqual({ afterSeconds: 5 });
  });

  it("omits the member entirely where the wire named no bound", () => {
    // A present-but-empty hint would render "said nothing about retrying" as "retry immediately".
    const refusal = normalizeWireRejection("repos", { code: "repo.not_found", message: "gone" });
    expect(refusal.retry).toBeUndefined();
    expect(Object.hasOwn(refusal, "retry")).toBe(false);
  });

  it("drops a reset instant it cannot read rather than reporting a wrong one", () => {
    // A malformed reset is a producer defect; the component shows no countdown rather than one to
    // a date that does not exist.
    expect(
      normalizeWireRejection("sessions", {
        code: "ratelimit.exceeded",
        message: "…",
        resetAt: "2026-02-30T12:00:00Z",
      }).retry,
    ).toBeUndefined();
  });

  it("ignores a negative or non-finite second count", () => {
    expect(
      normalizeWireRejection("sessions", { code: "x", message: "y", retryAfter: -1 }).retry,
    ).toBeUndefined();
    expect(
      normalizeWireRejection("sessions", { code: "x", message: "y", retryAfter: "soon" }).retry,
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
    // A member off `data.fields` reaches a component only because a reader is registered for it.
    const refusal = normalizeWireRejection("approvals", {
      code: -32603,
      message: "…",
      data: { type: "session.goal_delivery_failed", fields: { driverCode: "driver.timeout" } },
    });
    expect(Object.hasOwn(refusal, "driverCode")).toBe(false);
    expect(readRefusalExtensions(refusal)).toStrictEqual({});
  });
});
