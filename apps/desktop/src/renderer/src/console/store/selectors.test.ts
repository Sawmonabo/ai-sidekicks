// The stamped posture read, over a body built from the registered payload shape.
//
// The selector answers a question a surface uses to decide what to SHOW — what a
// run was allowed to do — so the failure it exists to prevent is a confident wrong
// answer rather than a missing one. Every case below therefore has a negative
// control that a trusting read would pass: a malformed posture, and a posture that
// satisfies the member types while violating an arm.
//
// Bodies are built here from the payload shapes rather than driven through
// `frame/run-lifecycle-projector.ts`. That projector does not carry the posture
// onto the run entity today, so a projector-driven case would fail for its gap and
// pass again when the gap closes — which asserts nothing about this module either
// way. The end-to-end path belongs to the projector's own test.

import { describe, expect, it } from "vitest";
import type { ExecutionPosture } from "@ai-sidekicks/contracts";

import type { ConsoleEntity } from "./entities.js";
import { stampedExecutionPostureOf } from "./selectors.js";

/** A run entity as the projector would leave it once it carries the payload through. */
function runEntityWithBody(body: Readonly<Record<string, unknown>>): ConsoleEntity {
  return { kind: "run", id: "run-1", state: "running", body };
}

describe("stampedExecutionPostureOf — the posture a run.running payload carried", () => {
  it("answers the stamped posture off a sandboxed run's body", () => {
    // The payload shape `runControl.ts` registers: a sandboxed mode carries a
    // credential-policy reference, and the unlisted network arm carries no domains.
    const posture: ExecutionPosture = {
      networkAccess: "none",
      writableRoots: ["/work/session-1"],
      mode: "workspace-sandboxed",
      credentialPolicyRef: "sha256:0f1e",
    };
    expect(stampedExecutionPostureOf(runEntityWithBody({ executionPosture: posture }))).toBe(
      posture,
    );
  });

  it("answers the stamped posture off a trusted run on the allow-list arm", () => {
    // The other side of both structural invariants at once: `allowedDomains` is
    // present and non-empty, and `credentialPolicyRef` is absent under `trusted`.
    const posture: ExecutionPosture = {
      networkAccess: "allowed-domains",
      allowedDomains: ["registry.example"],
      writableRoots: [],
      profileName: "default",
      mode: "trusted",
    };
    expect(stampedExecutionPostureOf(runEntityWithBody({ executionPosture: posture }))).toBe(
      posture,
    );
  });

  it("answers undefined for a run whose payload stamped no posture", () => {
    // Every non-`run.running` transition, which is most of them.
    expect(
      stampedExecutionPostureOf(runEntityWithBody({ runVersion: 3, newState: "queued" })),
    ).toBeUndefined();
  });

  it("answers undefined for a run with no body, and for no run at all", () => {
    expect(stampedExecutionPostureOf({ kind: "run", id: "run-2" })).toBeUndefined();
    expect(stampedExecutionPostureOf(undefined)).toBeUndefined();
  });

  it("negative control: a malformed posture yields undefined rather than itself", () => {
    // A read that trusted the member would hand a surface each of these and let it
    // render a permission surface off a value the contract cannot produce.
    const malformed: readonly unknown[] = [
      "workspace-sandboxed",
      { mode: "workspace-sandboxed" },
      { networkAccess: "none", writableRoots: ["/work"], mode: "invented-mode" },
      { networkAccess: "invented-access", writableRoots: [], mode: "trusted" },
      { networkAccess: "none", writableRoots: "/work", mode: "trusted" },
      { networkAccess: "none", writableRoots: [7], mode: "trusted" },
      { networkAccess: "none", writableRoots: [], mode: "trusted", profileName: 7 },
    ];
    for (const candidate of malformed) {
      expect(
        stampedExecutionPostureOf(runEntityWithBody({ executionPosture: candidate })),
      ).toBeUndefined();
    }
  });

  it("negative control: an arm violation the member types alone would admit yields undefined", () => {
    // Each of these has well-typed members and breaks one of the two invariants
    // the contract encodes structurally. A guard that checked only member types
    // would pass all four, and a surface would then render a trusted run that also
    // claims an enforced credential constraint, or an allow-list arm allowing
    // nothing.
    const armViolations: readonly unknown[] = [
      {
        networkAccess: "none",
        writableRoots: [],
        mode: "trusted",
        credentialPolicyRef: "sha256:0f",
      },
      { networkAccess: "none", writableRoots: [], mode: "workspace-sandboxed" },
      { networkAccess: "allowed-domains", allowedDomains: [], writableRoots: [], mode: "trusted" },
      {
        networkAccess: "full",
        allowedDomains: ["registry.example"],
        writableRoots: [],
        mode: "trusted",
      },
    ];
    for (const candidate of armViolations) {
      expect(
        stampedExecutionPostureOf(runEntityWithBody({ executionPosture: candidate })),
      ).toBeUndefined();
    }
  });
});
