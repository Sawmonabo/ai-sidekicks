// Proves neither the envelope refusal nor any resolution refusal can carry a path, and that the
// details the repository and worktree refusals put on the wire are the ones their contracts read.

import { describe, expect, it } from "vitest";

import { AgentIdSchema } from "@ai-sidekicks/contracts/agent/definition";
import { ProjectIdSchema } from "@ai-sidekicks/contracts/project";
import {
  REPO_OUTSIDE_TRUST_ENVELOPE_REASONS,
  RepoAlreadyAttachedDetailsSchema,
  RepoOutsideTrustEnvelopeDetailsSchema,
  RepoReattachConflictDetailsSchema,
  RepoReattachRefusedDetailsSchema,
} from "@ai-sidekicks/contracts/repo/folders";
import { RepoMountIdSchema } from "@ai-sidekicks/contracts/repo/mount";
import { SessionIdSchema } from "@ai-sidekicks/contracts/session/id";
import {
  RemovedWorktreeIdSchema,
  WorktreeCarryCheckoutRunningDetailsSchema,
  WorktreeIdSchema,
  WorktreeRetireIncompleteDetailsSchema,
} from "@ai-sidekicks/contracts/worktree/lifecycle";

import {
  WorktreeCreateFailedError,
  WorktreeRetireIncompleteError,
} from "../../../git/worktree/errors.js";
import { mapJsonRpcError } from "../../../ipc/jsonrpc-error-mapping.js";
import { mintUuidV7 } from "../../../uuid-v7.js";
import type { RepoRootResolutionReason } from "../errors.js";
import {
  RepoAlreadyAttachedError,
  RepoReattachConflictError,
  RepoReattachRefusedError,
  RepoRootResolutionError,
  TrustEnvelopeViolationError,
} from "../errors.js";

// A realistic personal path for the negative checks; no carrier has a channel that accepts one.
const ATTEMPTED_PATH = "/Users/operator/private-clients/acme-payments/src";

// A `Record` over the union fails compilation when a reason is added and not listed here.
const RESOLUTION_REASON_KEYS: Record<RepoRootResolutionReason, true> = {
  not_absolute: true,
  path_not_found: true,
  not_readable: true,
  not_a_repository: true,
  vcs_error: true,
  root_mismatch: true,
};

const EVERY_RESOLUTION_REASON = Object.keys(RESOLUTION_REASON_KEYS) as RepoRootResolutionReason[];

describe("path redaction — the attempted path cannot reach message or fields", () => {
  it("TrustEnvelopeViolationError leaks no path in message or detail", () => {
    for (const reason of REPO_OUTSIDE_TRUST_ENVELOPE_REASONS) {
      const error = new TrustEnvelopeViolationError(reason);
      expect(error.message).not.toContain(ATTEMPTED_PATH);
      expect(error.message).not.toMatch(/[/\\]/);
      expect(error.detail).toEqual({ reason });
      expect(JSON.stringify({ message: error.message, detail: error.detail })).not.toContain(
        ATTEMPTED_PATH,
      );
    }
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

describe("refusal details on the wire", () => {
  it("parses each refusal's emitted fields with its contract's details schema", () => {
    const repoMountId = RepoMountIdSchema.parse(mintUuidV7());
    const running = {
      runningSessionId: SessionIdSchema.parse(mintUuidV7()),
      runningAgentId: AgentIdSchema.parse(mintUuidV7()),
    };
    const refusals = [
      {
        error: new RepoAlreadyAttachedError(repoMountId, ProjectIdSchema.parse(mintUuidV7())),
        schema: RepoAlreadyAttachedDetailsSchema,
      },
      {
        error: new RepoAlreadyAttachedError(repoMountId, null),
        schema: RepoAlreadyAttachedDetailsSchema,
      },
      {
        error: new RepoReattachConflictError(running.runningSessionId, running.runningAgentId),
        schema: RepoReattachConflictDetailsSchema,
      },
      {
        error: new RepoReattachRefusedError(repoMountId),
        schema: RepoReattachRefusedDetailsSchema,
      },
      {
        error: new TrustEnvelopeViolationError("worktree_removed"),
        schema: RepoOutsideTrustEnvelopeDetailsSchema,
      },
      {
        error: new WorktreeRetireIncompleteError(
          {
            worktreeId: WorktreeIdSchema.parse(mintUuidV7()),
            removedWorktreeId: RemovedWorktreeIdSchema.parse(mintUuidV7()),
          },
          new Error("the folder was held open"),
        ),
        schema: WorktreeRetireIncompleteDetailsSchema,
      },
      {
        error: new WorktreeCreateFailedError("carry_checkout_running", running),
        schema: WorktreeCarryCheckoutRunningDetailsSchema,
      },
    ];

    for (const { error, schema } of refusals) {
      const fields = mapJsonRpcError(error, 1).error.data?.fields;
      expect(schema.parse(fields)).toEqual(error.detail);
    }
  });
});
