// The workflow secrets' values, held in the operating system's keychain under each
// secret's id. The record that names a secret, its place and name, is the daemon's
// table; this store holds only the value, and the value leaves the daemon only into the
// step that resolves it.
//
// The order is the caller's contract. Seal the value before writing the record, so a
// keychain that refuses leaves no record naming a value that is not there. On a delete,
// mark the record's removal first, then remove the value, then the record, so a crash in
// between is finished at the next start instead of leaving a value with no record.
//
// A keychain that accepts a write is not trusted to have kept it: some drop a write
// without an error (a locked login keychain, a policy that blocks the Windows
// credential store), so every seal reads the value back and compares it.
import { timingSafeEqual } from "node:crypto";

import type { WorkflowSecretId } from "@ai-sidekicks/contracts";

import { WorkflowSecretStoreUnavailableError, type SecretKeychain } from "./secret-keychain.js";

/** The keychain service the workflow secrets' values are filed under. */
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
   * The secret's value, or `undefined` when the keychain holds none, which the step
   * that asked reports as `workflow.secret_not_found`.
   */
  resolve(secretId: WorkflowSecretId): Promise<string | undefined> {
    return this.#keychain.read(secretId);
  }

  /** Removes a secret's value; removing one that is already gone succeeds. */
  async remove(secretId: WorkflowSecretId): Promise<void> {
    await this.#keychain.remove(secretId);
  }
}

// Compared in constant time, so the check reveals nothing about the value through timing.
function sameText(kept: string, expected: string): boolean {
  const keptBytes = Buffer.from(kept, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return keptBytes.length === expectedBytes.length && timingSafeEqual(keptBytes, expectedBytes);
}
