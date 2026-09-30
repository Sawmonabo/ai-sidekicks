// Registry conformance and redaction pins for the five `repo.*` typed error carriers: each one's
// code string and notional HTTP status, its JSON-RPC projection, and that no carrier can carry the
// attempted path. These are shape assertions on the carriers; an edit to the registry that is not
// mirrored here fails.

import { describe, expect, it } from "vitest";

import { JsonRpcErrorCode } from "@ai-sidekicks/contracts";

import { DaemonDomainError } from "../../ipc/domain-error.js";
import type { RepoRootResolutionReason } from "../repo-errors.js";
import {
  REPO_ERROR_CODES,
  RepoAlreadyAttachedError,
  RepoDetachConflictError,
  RepoMountNotFoundError,
  RepoRootResolutionError,
  TrustEnvelopeViolationError,
} from "../repo-errors.js";

// A realistic operator path. It is never injected into a carrier (none has a channel that accepts
// one); it supplies the negative control below. The enforcing assertions are the `[/\\]` separator
// checks, which catch any path, not only this one.
const ATTEMPTED_PATH = "/Users/operator/private-clients/acme-payments/src";

// Bare UUIDs, not prefixed handles: `RepoMountIdSchema` and `WorkspaceIdSchema` are branded UUID
// schemas, so an `rm-` or `ws-` prefixed fixture would fail to parse.
const SAMPLE_MOUNT_ID = "8f3c1a20-0f1e-4c77-9d2b-6a4e1f0b7c53";
const SAMPLE_CONFLICTING_MOUNT_ID = "1b7d9e44-3c22-4f81-8a05-2e9c6d33b1af";
const SAMPLE_BUSY_WORKSPACE_IDS = [
  "4d2a7c11-88b3-4e6f-a017-5c9f2b8e4d60",
  "9e5b3f08-71c4-4a2d-b3e8-0f6a1d7c9522",
];

/**
 * Total `Record` over the reason union: a member added to the union but not
 * listed here, or listed here but not in the union, is a compile error. Every
 * reason loop below derives from this, so a new reason's message is
 * redaction-checked with no further edit.
 */
const RESOLUTION_REASON_KEYS: Record<RepoRootResolutionReason, true> = {
  not_absolute: true,
  path_not_found: true,
  not_readable: true,
  not_a_git_repository: true,
  vcs_error: true,
  root_mismatch: true,
};

const EVERY_RESOLUTION_REASON = Object.keys(RESOLUTION_REASON_KEYS) as RepoRootResolutionReason[];

/** The only value a `RepoRootResolutionError` can be constructed from. */
type ResolutionReasonParameter = ConstructorParameters<typeof RepoRootResolutionError>[0];

/** Constructor parameter list of the argument-free envelope-violation carrier. */
type TrustEnvelopeArguments = ConstructorParameters<typeof TrustEnvelopeViolationError>;

/** One instance of each carrier, in registry order. */
function everyCarrier(): readonly DaemonDomainError[] {
  return [
    new RepoMountNotFoundError(SAMPLE_MOUNT_ID),
    new RepoRootResolutionError("path_not_found"),
    new TrustEnvelopeViolationError(),
    new RepoAlreadyAttachedError(SAMPLE_CONFLICTING_MOUNT_ID),
    new RepoDetachConflictError(SAMPLE_BUSY_WORKSPACE_IDS),
  ];
}

// ----------------------------------------------------------------------------
// Canonical code strings
// ----------------------------------------------------------------------------

describe("repo error carriers — canonical code strings", () => {
  it("RepoMountNotFoundError carries repo.not_found", () => {
    expect(new RepoMountNotFoundError(SAMPLE_MOUNT_ID).code).toBe("repo.not_found");
  });

  it("RepoRootResolutionError carries repo.root_resolution_failed", () => {
    expect(new RepoRootResolutionError("vcs_error").code).toBe("repo.root_resolution_failed");
  });

  it("TrustEnvelopeViolationError carries repo.outside_trust_envelope", () => {
    expect(new TrustEnvelopeViolationError().code).toBe("repo.outside_trust_envelope");
  });

  it("RepoAlreadyAttachedError carries repo.already_attached", () => {
    expect(new RepoAlreadyAttachedError(SAMPLE_CONFLICTING_MOUNT_ID).code).toBe(
      "repo.already_attached",
    );
  });

  it("RepoDetachConflictError carries repo.detach_conflict", () => {
    expect(new RepoDetachConflictError(SAMPLE_BUSY_WORKSPACE_IDS).code).toBe(
      "repo.detach_conflict",
    );
  });

  it("emits the same set as REPO_ERROR_CODES — no orphan row, no invented code", () => {
    const emittedCodes = everyCarrier().map((carrier) => carrier.code);
    expect([...emittedCodes].sort()).toEqual([...REPO_ERROR_CODES].sort());
  });

  it("pins the notional HTTP status of every row", () => {
    expect(new RepoMountNotFoundError(SAMPLE_MOUNT_ID).httpStatus).toBe(404);
    expect(new RepoRootResolutionError("path_not_found").httpStatus).toBe(422);
    expect(new TrustEnvelopeViolationError().httpStatus).toBe(403);
    expect(new RepoAlreadyAttachedError(SAMPLE_CONFLICTING_MOUNT_ID).httpStatus).toBe(409);
    expect(new RepoDetachConflictError(SAMPLE_BUSY_WORKSPACE_IDS).httpStatus).toBe(409);
  });
});

// ----------------------------------------------------------------------------
// Error subclass behavior and instanceof discrimination
// ----------------------------------------------------------------------------

describe("repo error carriers — Error subclass behavior", () => {
  it("every carrier is an Error with a stack and a non-empty message", () => {
    for (const carrier of everyCarrier()) {
      expect(carrier).toBeInstanceOf(Error);
      expect(carrier.stack).toBeDefined();
      expect(carrier.message.length).toBeGreaterThan(0);
    }
  });

  it("name reflects the concrete subclass (DaemonDomainError new.target contract)", () => {
    expect(new RepoMountNotFoundError(SAMPLE_MOUNT_ID).name).toBe("RepoMountNotFoundError");
    expect(new RepoRootResolutionError("not_readable").name).toBe("RepoRootResolutionError");
    expect(new TrustEnvelopeViolationError().name).toBe("TrustEnvelopeViolationError");
    expect(new RepoAlreadyAttachedError(SAMPLE_CONFLICTING_MOUNT_ID).name).toBe(
      "RepoAlreadyAttachedError",
    );
    expect(new RepoDetachConflictError(SAMPLE_BUSY_WORKSPACE_IDS).name).toBe(
      "RepoDetachConflictError",
    );
  });

  it("instanceof discriminates each carrier from its four siblings", () => {
    const mountNotFound = new RepoMountNotFoundError(SAMPLE_MOUNT_ID);
    const rootResolution = new RepoRootResolutionError("vcs_error");
    const trustEnvelope = new TrustEnvelopeViolationError();
    const alreadyAttached = new RepoAlreadyAttachedError(SAMPLE_CONFLICTING_MOUNT_ID);
    const detachConflict = new RepoDetachConflictError(SAMPLE_BUSY_WORKSPACE_IDS);

    expect(mountNotFound).toBeInstanceOf(RepoMountNotFoundError);
    expect(rootResolution).toBeInstanceOf(RepoRootResolutionError);
    expect(trustEnvelope).toBeInstanceOf(TrustEnvelopeViolationError);
    expect(alreadyAttached).toBeInstanceOf(RepoAlreadyAttachedError);
    expect(detachConflict).toBeInstanceOf(RepoDetachConflictError);

    // Siblings, never ancestors of one another: the carriers are a flat family under
    // DaemonDomainError, so a `catch` chain cannot mis-route.
    expect(rootResolution).not.toBeInstanceOf(TrustEnvelopeViolationError);
    expect(trustEnvelope).not.toBeInstanceOf(RepoRootResolutionError);
    expect(mountNotFound).not.toBeInstanceOf(RepoAlreadyAttachedError);
    expect(alreadyAttached).not.toBeInstanceOf(RepoMountNotFoundError);
    expect(detachConflict).not.toBeInstanceOf(RepoAlreadyAttachedError);
  });

  it("throws and is caught by its own class and by Error", () => {
    expect(() => {
      throw new TrustEnvelopeViolationError();
    }).toThrow(TrustEnvelopeViolationError);
    expect(() => {
      throw new RepoRootResolutionError("path_not_found");
    }).toThrow(Error);
  });
});

// ----------------------------------------------------------------------------
// Wire-projection shape
// ----------------------------------------------------------------------------

describe("repo error carriers — wire-projection shape", () => {
  it("every carrier extends DaemonDomainError, so it rides the single mapper branch", () => {
    // `mapJsonRpcError` has one generic `instanceof DaemonDomainError` branch, so no carrier
    // needs a mapper branch of its own.
    for (const carrier of everyCarrier()) {
      expect(carrier).toBeInstanceOf(DaemonDomainError);
    }
  });

  it("pins repo.not_found at -32602 InvalidParams, matching session.not_found", () => {
    // A supplied id that does not resolve is a param-shape failure, so a not-found error rides
    // `-32602` like `session.not_found`; pinning it in the carrier spares each consumer from
    // choosing a numeric.
    expect(new RepoMountNotFoundError(SAMPLE_MOUNT_ID).jsonRpcCode).toBe(
      JsonRpcErrorCode.InvalidParams,
    );
  });

  it("leaves jsonRpcCode unset on the other four (no unratified numeric)", () => {
    // None of these is a not-found shape and none has an assigned numeric, so they take the
    // mapper's `-32603` default while the dotted code rides `data.type`. Pinned so adopting a
    // numeric for any of them is a visible change.
    expect(new RepoRootResolutionError("path_not_found").jsonRpcCode).toBeUndefined();
    expect(new TrustEnvelopeViolationError().jsonRpcCode).toBeUndefined();
    expect(new RepoAlreadyAttachedError(SAMPLE_CONFLICTING_MOUNT_ID).jsonRpcCode).toBeUndefined();
    expect(new RepoDetachConflictError(SAMPLE_BUSY_WORKSPACE_IDS).jsonRpcCode).toBeUndefined();
  });
});

// ----------------------------------------------------------------------------
// Closed resolution-failure discriminant
// ----------------------------------------------------------------------------

describe("RepoRootResolutionError — closed reason discriminant (carrier leg)", () => {
  it("round-trips each reason onto the instance and into the wire detail", () => {
    for (const reason of EVERY_RESOLUTION_REASON) {
      const error = new RepoRootResolutionError(reason);
      expect(error.reason).toBe(reason);
      expect(error.detail?.["reason"]).toBe(reason);
    }
  });

  it("gives each reason a distinct fixed message", () => {
    const messages = EVERY_RESOLUTION_REASON.map(
      (reason) => new RepoRootResolutionError(reason).message,
    );
    expect(new Set(messages).size).toBe(EVERY_RESOLUTION_REASON.length);
  });

  it("refuses a free-form string in the only constructor slot", () => {
    // Compile-time closure pin: if the parameter widened to `string`, the annotation would
    // become `false` and assigning `true` would fail typecheck.
    const rejectsFreeFormString: string extends ResolutionReasonParameter ? false : true = true;
    expect(rejectsFreeFormString).toBe(true);
  });
});

// ----------------------------------------------------------------------------
// Path redaction
// ----------------------------------------------------------------------------

describe("path redaction — the attempted path cannot reach message or fields", () => {
  it("TrustEnvelopeViolationError exposes no constructor channel for a path", () => {
    // There is no way to construct the carrier with a path, so a leak is unrepresentable rather
    // than merely absent. Two type-level pins plus a runtime check:
    //   * the empty-tuple annotation rejects a new required parameter;
    //   * `["length"] extends 0` also rejects optional, defaulted and rest parameters, which the
    //     annotation alone tolerates;
    //   * `.length` is the runtime leg, because the type pins erase and `?` is type-level only
    //     (`constructor(p?: string)` emits `constructor(p)`); `Function.length` counts required
    //     and bare-optional parameters, so it observes the emitted signature.
    // Any signature change trips these on purpose: widening should be an explicit decision, even
    // for a closed non-path discriminant.
    const constructorArguments: TrustEnvelopeArguments = [];
    expect(constructorArguments).toHaveLength(0);
    expect(TrustEnvelopeViolationError.length).toBe(0);

    const acceptsNoArgument: TrustEnvelopeArguments["length"] extends 0 ? true : false = true;
    expect(acceptsNoArgument).toBe(true);
  });

  it("TrustEnvelopeViolationError leaks no path in message or detail", () => {
    const error = new TrustEnvelopeViolationError();
    expect(error.message).not.toContain(ATTEMPTED_PATH);
    expect(error.message).not.toMatch(/[/\\]/);
    expect(error.detail).toBeUndefined();
    expect(JSON.stringify({ message: error.message, detail: error.detail })).not.toContain(
      ATTEMPTED_PATH,
    );
  });

  it("RepoRootResolutionError leaks no path for any reason in the union", () => {
    // Derived from the union, so a reason added later is redaction-checked automatically.
    for (const reason of EVERY_RESOLUTION_REASON) {
      const error = new RepoRootResolutionError(reason);
      expect(error.message).not.toContain(ATTEMPTED_PATH);
      // No path separator of any flavor: Unix, UNC or Windows drive.
      expect(error.message).not.toMatch(/[/\\]/);
      const serialized = JSON.stringify({ message: error.message, detail: error.detail });
      expect(serialized).not.toContain(ATTEMPTED_PATH);
      expect(serialized).not.toMatch(/[/\\]/);
    }
  });

  it("negative control — the same assertions DO flag a message that echoes the path", () => {
    // Proves the checks above can fail: this is what a carrier that interpolated the attempted
    // path into its message would produce, and both assertions must catch it.
    const leakyMessage = `canonical repository root resolution failed: ${ATTEMPTED_PATH}`;
    expect(leakyMessage).toContain(ATTEMPTED_PATH);
    expect(leakyMessage).toMatch(/[/\\]/);
  });
});

// ----------------------------------------------------------------------------
// Structured detail projected into data.fields
// ----------------------------------------------------------------------------

describe("repo error carriers — structured detail payloads", () => {
  it("RepoMountNotFoundError carries the unresolved mount id", () => {
    const error = new RepoMountNotFoundError(SAMPLE_MOUNT_ID);
    expect(error.repoMountId).toBe(SAMPLE_MOUNT_ID);
    expect(error.detail).toEqual({ repoMountId: SAMPLE_MOUNT_ID });
    expect(error.message).toContain(SAMPLE_MOUNT_ID);
  });

  it("RepoAlreadyAttachedError carries the conflicting mount id (refusal)", () => {
    const error = new RepoAlreadyAttachedError(SAMPLE_CONFLICTING_MOUNT_ID);
    expect(error.conflictingRepoMountId).toBe(SAMPLE_CONFLICTING_MOUNT_ID);
    expect(error.detail).toEqual({ conflictingRepoMountId: SAMPLE_CONFLICTING_MOUNT_ID });
  });

  it("RepoDetachConflictError carries the busy workspace ids and their count", () => {
    const error = new RepoDetachConflictError(SAMPLE_BUSY_WORKSPACE_IDS);
    expect(error.busyWorkspaceIds).toEqual(SAMPLE_BUSY_WORKSPACE_IDS);
    expect(error.detail).toEqual({ busyWorkspaceIds: SAMPLE_BUSY_WORKSPACE_IDS });
    expect(error.message).toContain(`${SAMPLE_BUSY_WORKSPACE_IDS.length} dependent workspace(s)`);
    expect(error.message).toContain("no force-detach in V1");
  });

  it("RepoDetachConflictError copies the id list against later caller mutation", () => {
    const callerOwnedIds = [...SAMPLE_BUSY_WORKSPACE_IDS];
    const error = new RepoDetachConflictError(callerOwnedIds);
    // Appended after construction: had the carrier kept the caller's array, this id would
    // surface in both assertions below.
    callerOwnedIds.push("c0ffee11-2233-4455-8677-889900aabbcc");
    expect(error.busyWorkspaceIds).toEqual(SAMPLE_BUSY_WORKSPACE_IDS);
    expect(error.detail).toEqual({ busyWorkspaceIds: SAMPLE_BUSY_WORKSPACE_IDS });
  });

  it("leaves detail undefined on the carrier that supplies none", () => {
    // Checked by value, not with `"detail" in error`: under `useDefineForClassFields` the own
    // property exists holding `undefined`. The value check is also the predicate
    // `mapJsonRpcError` uses (`thrown.detail !== undefined`) to decide whether to emit
    // `data.fields`.
    expect(new TrustEnvelopeViolationError().detail).toBeUndefined();
  });
});
