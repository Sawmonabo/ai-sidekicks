// Proves each of the five `repo.*` carriers matches its registry row (code and notional status),
// that every carrier is a DaemonDomainError and they discriminate by class, and that neither the
// envelope refusal nor any resolution refusal can carry a path.

import { describe, expect, it } from "vitest";

import { DaemonDomainError } from "../../ipc/domain-error.js";
import type { RepoRootResolutionReason } from "../repo-errors.js";
import {
  RepoAlreadyAttachedError,
  RepoDetachConflictError,
  RepoMountNotFoundError,
  RepoRootResolutionError,
  TrustEnvelopeViolationError,
} from "../repo-errors.js";

// A realistic operator path for the negative checks; no carrier has a channel that accepts one.
const ATTEMPTED_PATH = "/Users/operator/private-clients/acme-payments/src";

// Bare UUIDs: the mount and workspace id schemas are branded UUIDs.
const SAMPLE_MOUNT_ID = "8f3c1a20-0f1e-4c77-9d2b-6a4e1f0b7c53";
const SAMPLE_CONFLICTING_MOUNT_ID = "1b7d9e44-3c22-4f81-8a05-2e9c6d33b1af";
const SAMPLE_BUSY_WORKSPACE_IDS = [
  "4d2a7c11-88b3-4e6f-a017-5c9f2b8e4d60",
  "9e5b3f08-71c4-4a2d-b3e8-0f6a1d7c9522",
];

// A `Record` over the union fails compilation when a reason is added and not listed here.
const RESOLUTION_REASON_KEYS: Record<RepoRootResolutionReason, true> = {
  not_absolute: true,
  path_not_found: true,
  not_readable: true,
  not_a_git_repository: true,
  vcs_error: true,
  root_mismatch: true,
};

const EVERY_RESOLUTION_REASON = Object.keys(RESOLUTION_REASON_KEYS) as RepoRootResolutionReason[];

function everyCarrier(): readonly DaemonDomainError[] {
  return [
    new RepoMountNotFoundError(SAMPLE_MOUNT_ID),
    new RepoRootResolutionError("path_not_found"),
    new TrustEnvelopeViolationError(),
    new RepoAlreadyAttachedError(SAMPLE_CONFLICTING_MOUNT_ID),
    new RepoDetachConflictError(SAMPLE_BUSY_WORKSPACE_IDS),
  ];
}

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

  it("pins the notional HTTP status of every row", () => {
    expect(new RepoMountNotFoundError(SAMPLE_MOUNT_ID).httpStatus).toBe(404);
    expect(new RepoRootResolutionError("path_not_found").httpStatus).toBe(422);
    expect(new TrustEnvelopeViolationError().httpStatus).toBe(403);
    expect(new RepoAlreadyAttachedError(SAMPLE_CONFLICTING_MOUNT_ID).httpStatus).toBe(409);
    expect(new RepoDetachConflictError(SAMPLE_BUSY_WORKSPACE_IDS).httpStatus).toBe(409);
  });
});

describe("repo error carriers — Error subclass behavior", () => {
  it("every carrier extends DaemonDomainError, so it rides the single mapper branch", () => {
    // `mapJsonRpcError` has one generic `instanceof DaemonDomainError` branch, so no carrier
    // needs a mapper branch of its own.
    for (const carrier of everyCarrier()) {
      expect(carrier).toBeInstanceOf(DaemonDomainError);
    }
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

    // Siblings, never ancestors of one another, so a `catch` chain cannot mis-route.
    expect(rootResolution).not.toBeInstanceOf(TrustEnvelopeViolationError);
    expect(trustEnvelope).not.toBeInstanceOf(RepoRootResolutionError);
    expect(mountNotFound).not.toBeInstanceOf(RepoAlreadyAttachedError);
    expect(alreadyAttached).not.toBeInstanceOf(RepoMountNotFoundError);
    expect(detachConflict).not.toBeInstanceOf(RepoAlreadyAttachedError);
  });
});

describe("path redaction — the attempted path cannot reach message or fields", () => {
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
});
