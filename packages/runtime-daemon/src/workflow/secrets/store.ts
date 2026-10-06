// The workflow secrets' values, held in the operating system's keychain under each secret's id.
// The daemon's table records a secret's place and name; this store holds only the value, which
// leaves the daemon only into the step that resolves it.
//
// Call order is the caller's contract. Seal the value before writing the record, so a refusing
// keychain leaves no record naming a missing value. To delete, mark the record's removal, remove
// the value, then remove the record, so a crash in between is finished at the next start instead
// of leaving a value with no record.
//
// A keychain that accepts a write may not have kept it (a locked login keychain or a policy on
// the Windows credential store can drop it without an error), so every seal reads the value
// back and compares.
import { timingSafeEqual } from "node:crypto";

import type { WorkflowSecretId } from "@ai-sidekicks/contracts/workflow/secret";

import { WorkflowSecretStoreUnavailableError, type SecretKeychain } from "./keychain.js";

/**
 * The keychain service name the workflow secrets' values are filed under.
 *
 * @consumedBy the daemon's start-up, when it builds the workflow secret store
 */
export const WORKFLOW_SECRET_KEYCHAIN_SERVICE = "ai-sidekicks-workflow-secrets";

/** Seals, resolves and removes workflow secrets' values in the keychain. */
export class WorkflowSecretStore {
  readonly #keychain: SecretKeychain;

  constructor(keychain: SecretKeychain) {
    this.#keychain = keychain;
  }

  /**
   * Seals a secret's value, the first or a replacement, and confirms the keychain kept
   * it. Rejects with {@link WorkflowSecretStoreUnavailableError} when the keychain is
   * locked, missing, or did not keep the value.
   */
  async seal(secretId: WorkflowSecretId, secretValue: string): Promise<void> {
    await this.#keychain.write(secretId, secretValue);
    const kept = await this.#keychain.read(secretId);
    if (kept === undefined || !sameText(kept, secretValue)) {
      throw new WorkflowSecretStoreUnavailableError(
        "unavailable",
        "it accepted the value but did not keep it",
      );
    }
  }

  /**
   * The secret's value, or `undefined` when the keychain holds none; the step that asked
   * reports that as `workflow.secret_not_found`.
   */
  resolve(secretId: WorkflowSecretId): Promise<string | undefined> {
    return this.#keychain.read(secretId);
  }

  /** Removes a secret's value; removing one that is already gone succeeds. */
  async remove(secretId: WorkflowSecretId): Promise<void> {
    await this.#keychain.remove(secretId);
  }
}

// Constant-time comparison, so the check leaks nothing about the value through timing.
function sameText(kept: string, expected: string): boolean {
  const keptBytes = Buffer.from(kept, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return keptBytes.length === expectedBytes.length && timingSafeEqual(keptBytes, expectedBytes);
}
