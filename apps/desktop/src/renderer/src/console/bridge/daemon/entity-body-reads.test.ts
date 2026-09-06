// The two body reads, over bodies built from the registered payload shapes.
//
// Both selectors answer a question a surface uses to decide what to OFFER — what a
// run was allowed to do, and what this window is allowed to do — so the failure
// they exist to prevent is a confident wrong answer rather than a missing one.
// Every case below therefore has a negative control that a trusting read would
// pass: a malformed posture, a posture that satisfies the member types but
// violates an arm, and a role string the contract does not carry.
//
// Bodies are built here from the payload shapes rather than driven through
// `frame/run-lifecycle-projector.ts`. That projector does not carry the posture
// onto the run entity today, so a projector-driven case would fail for its gap and
// pass again when the gap closes — which asserts nothing about this module either
// way. The end-to-end path belongs to the projector's own test.

import { describe, expect, it } from "vitest";
import type { ExecutionPosture } from "@ai-sidekicks/contracts";

import type { ConsoleEntity } from "../../store/index.js";
import { membershipRoleOf, stampedExecutionPostureOf } from "./entity-body-reads.js";

/** A run entity as the projector would leave it once it carries the payload through. */
function runEntityWithBody(body: Readonly<Record<string, unknown>>): ConsoleEntity {
  return { kind: "run", id: "run-1", state: "running", body };
}

/** A roster entry as a session read establishes it. */
function participantEntry(
  participantId: string,
  body: Readonly<Record<string, unknown>> | undefined,
): ConsoleEntity {
  return {
    kind: "participant",
    id: participantId,
    ...(body === undefined ? {} : { body }),
  };
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

  it("negative control: values the wire string rules refuse yield undefined, never themselves", () => {
    // The class the hand-written mirror could not see. It checked member TYPES and
    // arm presence, so each of these — a well-typed string in the right arm — was
    // admitted and handed to a permission surface, while the contract composes
    // `wireFreeFormString` and `filesystemPathSchema` and refuses every one:
    // `credentialPolicyRef` empty or carrying a NUL, `profileName` whitespace-only,
    // a writable root that is the empty string or carries a NUL.
    const wireRefused: readonly unknown[] = [
      {
        networkAccess: "none",
        writableRoots: [],
        mode: "workspace-sandboxed",
        credentialPolicyRef: "",
      },
      {
        networkAccess: "none",
        writableRoots: [],
        mode: "workspace-sandboxed",
        credentialPolicyRef: "sha256:0f\u0000",
      },
      { networkAccess: "none", writableRoots: [], mode: "trusted", profileName: "   " },
      { networkAccess: "none", writableRoots: [""], mode: "trusted" },
      { networkAccess: "none", writableRoots: ["/work\u0000"], mode: "trusted" },
    ];
    for (const candidate of wireRefused) {
      expect(
        stampedExecutionPostureOf(runEntityWithBody({ executionPosture: candidate })),
      ).toBeUndefined();
    }
  });

  it("negative control: a member the registered shape does not carry yields undefined", () => {
    // The other thing a mirror cannot do: the contract's posture arms are strict, so
    // an unregistered member is a posture no daemon stamps. A predicate that checked
    // only the members it knew about admitted this one whole.
    expect(
      stampedExecutionPostureOf(
        runEntityWithBody({
          executionPosture: {
            networkAccess: "none",
            writableRoots: [],
            mode: "trusted",
            invented: true,
          },
        }),
      ),
    ).toBeUndefined();
  });

  it("the carrier the parse runs over is itself admissible, so a refusal is the posture's", () => {
    // The registered posture parse is declared per EVENT, so the selector presents
    // each candidate on a fixed carrier. If a member were added to that event, the
    // carrier would stop parsing and EVERY posture would read as absent — a silent
    // return to "not checked" that every refusal case above would keep passing over.
    // The smallest posture the contract admits is what separates the two: it can
    // only be answered if the carrier around it parsed.
    const minimal: ExecutionPosture = {
      networkAccess: "none",
      writableRoots: [],
      mode: "trusted",
    };
    expect(stampedExecutionPostureOf(runEntityWithBody({ executionPosture: minimal }))).toBe(
      minimal,
    );
  });
});

describe("membershipRoleOf — the role the roster carries", () => {
  it("answers the role the participant entry carries", () => {
    expect(membershipRoleOf(participantEntry("participant-1", { role: "owner" }))).toBe("owner");
  });

  it("answers the multi-word role verbatim, as the wire spells it", () => {
    // `"runtime contributor"` carries its space on the wire. A read that normalised
    // it would answer a role no contract carries.
    expect(
      membershipRoleOf(participantEntry("participant-1", { role: "runtime contributor" })),
    ).toBe("runtime contributor");
  });

  it("answers undefined for a participant the partition does not hold", () => {
    // The absent entry, which is what the store's own `selectEntity` hands over for
    // an id no partition carries.
    expect(membershipRoleOf(undefined)).toBeUndefined();
  });

  it("answers undefined for an entry carrying no role", () => {
    expect(membershipRoleOf(participantEntry("participant-1", undefined))).toBeUndefined();
    expect(membershipRoleOf(participantEntry("participant-1", { handle: "ada" }))).toBeUndefined();
  });

  it("negative control: a role the contract does not carry yields undefined, never itself", () => {
    // Without this, every case above would pass over a read that returned the member
    // unchecked — and a surface would offer an owner's controls to whatever string a
    // body happened to hold.
    for (const candidate of ["admin", "OWNER", "", 7, null, { role: "owner" }]) {
      expect(
        membershipRoleOf(participantEntry("participant-1", { role: candidate })),
      ).toBeUndefined();
    }
  });
});
