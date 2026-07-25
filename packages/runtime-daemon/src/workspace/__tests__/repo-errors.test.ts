// repo-errors.test.ts — registry conformance and redaction pins for the five
// `repo.*` typed carriers (Plan-009 Phase 1 T1.4).
//
// Spec coverage:
//   * `Spec-009 §Fallback Behavior` — canonical-root resolution failure is
//     explicit, never a guess; `RepoRootResolutionError` is that carrier.
//   * `Spec-009 §Required Behavior` + `Spec-009 §Local Trust Envelope (V1
//     Definition)` — traversal / outside-envelope binding is rejected with
//     the typed `repo.outside_trust_envelope` error.
//   * `Spec-009 §Detach Semantics (V1 Definition)` — detach is refused with
//     `repo.detach_conflict` while a dependent workspace is `busy`.
//   * `error-contracts.md §Repo` — the ratified five-row registry: every
//     code string and notional HTTP status asserted below is quoted from
//     that table, so a registry edit that is not mirrored here fails.
//
// Invariants covered (canonical text in
// `docs/plans/009-repo-attachment-and-workspace-binding.md §Invariants`):
//   * I-009-2 — carrier leg. A typed class permanently fixed to
//     `repo.root_resolution_failed` with a closed, non-path-bearing reason.
//     The never-guess-a-root enforcement is T1.5's and is tested there.
//   * I-009-3 — carrier leg. A typed class fixed to
//     `repo.outside_trust_envelope` that cannot carry the attempted path.
//     The containment check itself is T1.6's and is tested there.
//
// Scope boundary: these are shape assertions on the carriers. The wire
// round-trip through `mapJsonRpcError` (numeric, `data.type`, `data.fields`)
// is Phase 3 T3.6's surface and is deliberately not duplicated here; what is
// pinned instead is the structural precondition for it — every carrier
// extends `DaemonDomainError`, so it reaches that mapper's single generic
// projection branch with no per-class mapper edit.

import { describe, expect, it } from "vitest";

import { JsonRpcErrorCode } from "@ai-sidekicks/contracts";

import { DaemonDomainError } from "../../ipc/domain-error.js";
import type { RepoErrorCode, RepoRootResolutionReason } from "../repo-errors.js";
// Namespace import for the export census below: it observes every export the
// module actually has, which the named list by construction cannot.
import * as repoErrorModule from "../repo-errors.js";
import {
  REPO_ERROR_CODES,
  RepoAlreadyAttachedError,
  RepoDetachConflictError,
  RepoMountNotFoundError,
  RepoRootResolutionError,
  TrustEnvelopeViolationError,
} from "../repo-errors.js";

// A realistic operator path. NOT injected into any carrier — none exposes a
// channel that would accept one. It documents the threat model (this is the
// shape the §Repo ban exists to keep off the wire) and supplies the negative
// control below. The enforcing assertions are the `[/\\]` separator checks,
// which catch ANY path rather than only this one.
const ATTEMPTED_PATH = "/Users/operator/private-clients/acme-payments/src";

// Bare UUIDs, not prefixed handles. T1.1's `RepoMountIdSchema` /
// `WorkspaceIdSchema` are `brandedUuidIdSchema` (`z.string().uuid()`), so an
// `rm-` / `ws-`-prefixed fixture would fail to parse — and a fixture here is
// what a Phase 2 author copies.
const SAMPLE_MOUNT_ID = "8f3c1a20-0f1e-4c77-9d2b-6a4e1f0b7c53";
const SAMPLE_CONFLICTING_MOUNT_ID = "1b7d9e44-3c22-4f81-8a05-2e9c6d33b1af";
const SAMPLE_BUSY_WORKSPACE_IDS = [
  "4d2a7c11-88b3-4e6f-a017-5c9f2b8e4d60",
  "9e5b3f08-71c4-4a2d-b3e8-0f6a1d7c9522",
];

/**
 * Total `Record` over the reason union: a member added to the union but not
 * listed here, or listed here but not in the union, is a compile error. Every
 * reason loop below derives from this rather than hardcoding the three, so the
 * loops grow with the union. That matters most for the redaction assertions —
 * a future reason whose message escaped them would be a silent hole in the
 * §Repo no-echo guarantee.
 */
const RESOLUTION_REASON_KEYS: Record<RepoRootResolutionReason, true> = {
  path_not_found: true,
  not_readable: true,
  vcs_error: true,
};

const EVERY_RESOLUTION_REASON = Object.keys(RESOLUTION_REASON_KEYS) as RepoRootResolutionReason[];

/** The only value a `RepoRootResolutionError` can be constructed from. */
type ResolutionReasonParameter = ConstructorParameters<typeof RepoRootResolutionError>[0];

/** Constructor parameter list of the argument-free envelope-violation carrier. */
type TrustEnvelopeArguments = ConstructorParameters<typeof TrustEnvelopeViolationError>;

/** One instance of each carrier, in `error-contracts.md §Repo` row order. */
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
// Registry conformance — error-contracts.md §Repo
// ----------------------------------------------------------------------------

describe("repo error carriers — canonical code strings (error-contracts.md §Repo)", () => {
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
    // Drift detector, scoped to what `everyCarrier()` enumerates: a §Repo row
    // with no carrier fails here, as does one of THESE five minting a code the
    // registry does not list. A sixth carrier added to the module but not to
    // the helper is invisible to this assertion — the export census below is
    // what closes that gap.
    const emittedCodes = everyCarrier().map((carrier) => carrier.code);
    expect([...emittedCodes].sort()).toEqual([...REPO_ERROR_CODES].sort());
  });

  it("exports exactly five error constructors — a sixth carrier fails the census", () => {
    // Observes the module's real export surface rather than a hand-kept list,
    // so a carrier added without a corresponding registry row and test cannot
    // slip through the scoping caveat above.
    const exportedErrorConstructors = Object.entries(repoErrorModule).filter(
      ([, exported]) =>
        typeof exported === "function" && exported.prototype instanceof DaemonDomainError,
    );
    expect(exportedErrorConstructors).toHaveLength(REPO_ERROR_CODES.length);
  });

  it("REPO_ERROR_CODES enumerates exactly the RepoErrorCode union", () => {
    // Total `Record` over the union: a member missing below, or a key that
    // is not a member, is a compile error. The runtime comparison then pins
    // the exported tuple to that same set.
    const everyRegistryCode: Record<RepoErrorCode, true> = {
      "repo.not_found": true,
      "repo.root_resolution_failed": true,
      "repo.outside_trust_envelope": true,
      "repo.already_attached": true,
      "repo.detach_conflict": true,
    };
    expect(Object.keys(everyRegistryCode).sort()).toEqual([...REPO_ERROR_CODES].sort());
  });

  it("pins the notional HTTP status of every row (error-contracts.md §Repo status column)", () => {
    expect(new RepoMountNotFoundError(SAMPLE_MOUNT_ID).httpStatus).toBe(404);
    expect(new RepoRootResolutionError("path_not_found").httpStatus).toBe(422);
    expect(new TrustEnvelopeViolationError().httpStatus).toBe(403);
    expect(new RepoAlreadyAttachedError(SAMPLE_CONFLICTING_MOUNT_ID).httpStatus).toBe(409);
    expect(new RepoDetachConflictError(SAMPLE_BUSY_WORKSPACE_IDS).httpStatus).toBe(409);
  });
});

// ----------------------------------------------------------------------------
// Error-subclass behavior + instanceof discrimination
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

    // Siblings, never ancestors of one another — the carriers are a flat
    // family under DaemonDomainError, so a `catch` chain cannot mis-route.
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
// Wire-projection shape — the structural precondition for Phase 3 T3.6
// ----------------------------------------------------------------------------

describe("repo error carriers — wire-projection shape", () => {
  it("every carrier extends DaemonDomainError, so it rides the single mapper branch", () => {
    // This is what makes the AC's "Phase 2/3 map onto the JSON-RPC envelope
    // without re-keying" true: `mapJsonRpcError` already has one generic
    // `instanceof DaemonDomainError` branch (BL-143, a landed Plan-009
    // §Preconditions row), so no phase adds a per-class branch.
    for (const carrier of everyCarrier()) {
      expect(carrier).toBeInstanceOf(DaemonDomainError);
    }
  });

  it("pins repo.not_found at -32602 InvalidParams, matching session.not_found", () => {
    // The base class's own rule: a supplied id that does not resolve is a
    // param-shape failure. BL-143 landed `repo.not_found` at `-32602` as its
    // worked example on both sides of the wire, so pinning it in the carrier
    // is what spares Phase 3 from editing a Phase 1 file.
    expect(new RepoMountNotFoundError(SAMPLE_MOUNT_ID).jsonRpcCode).toBe(
      JsonRpcErrorCode.InvalidParams,
    );
  });

  it("leaves jsonRpcCode unset on the other four (no unratified numeric)", () => {
    // None of these is a not-found shape and no numeric is ratified for their
    // rows, so they take the mapper's `-32603` default while the dotted
    // identifier rides `data.type`. Pinned so adopting a numeric for any of
    // them is a deliberate, visible change rather than a drift.
    expect(new RepoRootResolutionError("path_not_found").jsonRpcCode).toBeUndefined();
    expect(new TrustEnvelopeViolationError().jsonRpcCode).toBeUndefined();
    expect(new RepoAlreadyAttachedError(SAMPLE_CONFLICTING_MOUNT_ID).jsonRpcCode).toBeUndefined();
    expect(new RepoDetachConflictError(SAMPLE_BUSY_WORKSPACE_IDS).jsonRpcCode).toBeUndefined();
  });
});

// ----------------------------------------------------------------------------
// I-009-2 carrier leg — the closed resolution-failure discriminant
// ----------------------------------------------------------------------------

describe("RepoRootResolutionError — closed reason discriminant (I-009-2 carrier leg)", () => {
  it("accepts exactly the three ratified reasons", () => {
    // The union's member set is pinned at compile time by
    // `RESOLUTION_REASON_KEYS` being a total `Record`; this fixes the count
    // and spelling so a fourth member cannot land silently.
    expect([...EVERY_RESOLUTION_REASON].sort()).toEqual([
      "not_readable",
      "path_not_found",
      "vcs_error",
    ]);
  });

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
    // Compile-time closure pin. If the parameter ever widened to `string`,
    // `string extends ResolutionReasonParameter` flips to true, the
    // annotation becomes `false`, and assigning `true` fails typecheck.
    const rejectsFreeFormString: string extends ResolutionReasonParameter ? false : true = true;
    expect(rejectsFreeFormString).toBe(true);
  });
});

// ----------------------------------------------------------------------------
// Path redaction — error-contracts.md §Repo no-echo discipline
// ----------------------------------------------------------------------------

describe("path redaction — the attempted path cannot reach message or fields", () => {
  it("TrustEnvelopeViolationError exposes no constructor channel for a path", () => {
    // Plan-009 T1.4 prescribes a carrier "constructed with an attempted path"
    // that does not leak it into `message`. This satisfies that in the
    // stronger structural form — there is no way to construct it WITH a path,
    // so the leak is unrepresentable rather than merely absent. A plan-vs-test
    // differ should read the missing literal case as subsumed, not skipped.
    //
    // Two type-level pins plus a runtime cross-check:
    //   * the empty-tuple annotation rejects a new REQUIRED parameter;
    //   * `["length"] extends 0` additionally rejects optional, defaulted,
    //     and rest parameters — each widens the parameter list's length to
    //     `0 | 1` or `number`, which the annotation alone tolerates;
    //   * `.length` is the runtime leg, and it is not redundant: TypeScript's
    //     `?` is type-level only, so `constructor(p?: string)` emits
    //     `constructor(p)`. `Function.length` counts required and
    //     bare-optional parameters but not defaulted or rest ones, so
    //     `.length` re-asserts those two cases at runtime, while the type pin
    //     covers all four at compile time. Both legs matter: the type pins
    //     erase, leaving nothing that observes the emitted signature.
    // Together they trip on any signature change. That is deliberate: widening
    // here should be an explicit decision, even for the closed non-path
    // discriminant Phase 3 might legitimately want.
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
    // Derived, not hardcoded: a reason added later is redaction-checked here
    // automatically instead of quietly escaping the guarantee.
    for (const reason of EVERY_RESOLUTION_REASON) {
      const error = new RepoRootResolutionError(reason);
      expect(error.message).not.toContain(ATTEMPTED_PATH);
      // No path separator of any flavor — Unix, UNC, or Windows-drive.
      expect(error.message).not.toMatch(/[/\\]/);
      const serialized = JSON.stringify({ message: error.message, detail: error.detail });
      expect(serialized).not.toContain(ATTEMPTED_PATH);
      expect(serialized).not.toMatch(/[/\\]/);
    }
  });

  it("negative control — the same assertions DO flag a message that echoes the path", () => {
    // Proves the two checks above can fail. This is the shape a carrier
    // would produce if it interpolated the attempted path into its message;
    // both assertions must catch it, otherwise the clean results above are
    // vacuous.
    const leakyMessage = `canonical repository root resolution failed: ${ATTEMPTED_PATH}`;
    expect(leakyMessage).toContain(ATTEMPTED_PATH);
    expect(leakyMessage).toMatch(/[/\\]/);
  });
});

// ----------------------------------------------------------------------------
// Structured detail — the payloads Phase 2/3 project into data.fields
// ----------------------------------------------------------------------------

describe("repo error carriers — structured detail payloads", () => {
  it("RepoMountNotFoundError carries the unresolved mount id", () => {
    const error = new RepoMountNotFoundError(SAMPLE_MOUNT_ID);
    expect(error.repoMountId).toBe(SAMPLE_MOUNT_ID);
    expect(error.detail).toEqual({ repoMountId: SAMPLE_MOUNT_ID });
    expect(error.message).toContain(SAMPLE_MOUNT_ID);
  });

  it("RepoAlreadyAttachedError carries the conflicting mount id (D-009-7 refusal)", () => {
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
    // Appended AFTER construction: had the carrier retained the caller's array
    // rather than copying it, this id would surface in both assertions below.
    callerOwnedIds.push("c0ffee11-2233-4455-8677-889900aabbcc");
    expect(error.busyWorkspaceIds).toEqual(SAMPLE_BUSY_WORKSPACE_IDS);
    expect(error.detail).toEqual({ busyWorkspaceIds: SAMPLE_BUSY_WORKSPACE_IDS });
  });

  it("leaves detail undefined on the carrier that supplies none", () => {
    // Asserted as `=== undefined`, not `"detail" in error === false`. Under
    // `useDefineForClassFields` the base's `readonly detail?:` declaration is
    // emitted as a field, so the own property EXISTS holding `undefined` and
    // the `in` form would always be true. The value check is also the exact
    // predicate `mapJsonRpcError` uses (`thrown.detail !== undefined`) to
    // decide whether to emit `data.fields`, so it is the one that governs.
    expect(new TrustEnvelopeViolationError().detail).toBeUndefined();
  });
});
