// Proves neither the envelope refusal nor any resolution refusal can carry a path.

import { describe, expect, it } from "vitest";

import type { RepoRootResolutionReason } from "../errors.js";
import { RepoRootResolutionError, TrustEnvelopeViolationError } from "../errors.js";

// A realistic personal path for the negative checks; no carrier has a channel that accepts one.
const ATTEMPTED_PATH = "/Users/operator/private-clients/acme-payments/src";

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
