// The workflow secrets' values, held in a keychain under each secret's id. The daemon's table
// records a secret's place and name; this store holds only the value, which leaves the daemon
// only into the step that resolves it.
//
// The store takes a `SecretKeychain` and holds no keychain code: `keychain/os.ts` is the
// operating system's keychain, and `keychain/file.ts` the daemon's items file where that keychain
// cannot be used. Tests therefore run the store's rules without touching a real keychain, and the
// native binding stays out of modules that only need the store's shape.
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

import type { KeychainRefusalCause } from "@ai-sidekicks/contracts/provider/account/sign-in";
import {
  WORKFLOW_SECRET_STORE_UNAVAILABLE_CODE,
  type WorkflowSecretId,
} from "@ai-sidekicks/contracts/workflow/secret";

import { DaemonDomainError } from "../../ipc/domain-error.js";

/**
 * One keychain service's entries, each addressed by an account name. A keychain that is locked,
 * missing or silent rejects with {@link WorkflowSecretStoreUnavailableError}; the operating
 * system's keychain settles in bounded time, and the items file when its file system answers.
 */
export interface SecretKeychain {
  /** Writes `value` under `account`, replacing any value held there. */
  write(account: string, value: string): Promise<void>;
  /** The value held under `account`, or `undefined` when none is. */
  read(account: string): Promise<string | undefined>;
  /** Removes the value under `account`; `false` when none was held. */
  remove(account: string): Promise<boolean>;
}

/**
 * The keychain could not be used: it is locked, or the machine has none the daemon can use.
 * Projects to `workflow.secret_store_unavailable` with its cause. The message carries the
 * keychain's own failure text and never a secret value; `failure` is kept as the error's cause.
 */
export class WorkflowSecretStoreUnavailableError extends DaemonDomainError {
  readonly unavailableCause: KeychainRefusalCause;

  constructor(unavailableCause: KeychainRefusalCause, keychainMessage: string, failure?: unknown) {
    super(`The keychain is ${unavailableCause}: ${keychainMessage}`, {
      code: WORKFLOW_SECRET_STORE_UNAVAILABLE_CODE,
      detail: { cause: unavailableCause },
      cause: failure,
    });
    this.unavailableCause = unavailableCause;
  }
}

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
