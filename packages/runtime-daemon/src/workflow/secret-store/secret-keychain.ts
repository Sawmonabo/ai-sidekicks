// The seam between the workflow secret store and the operating system's keychain. The store
// takes a `SecretKeychain` and holds no keychain code; `os-secret-keychain.ts` is the platform
// implementation. Tests therefore run the store's rules without touching a real keychain, and
// the native binding stays out of modules that only need the store's shape.
import {
  WORKFLOW_SECRET_STORE_UNAVAILABLE_CODE,
  type WorkflowSecretStoreUnavailableCause,
} from "@ai-sidekicks/contracts";

import { DaemonDomainError } from "../../ipc/domain-error.js";

/**
 * One keychain service's entries, each addressed by an account name. Every method settles in
 * bounded time; a keychain that is locked, missing or silent rejects with
 * {@link WorkflowSecretStoreUnavailableError}.
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
 * keychain's own failure text and never a secret value.
 */
export class WorkflowSecretStoreUnavailableError extends DaemonDomainError {
  readonly unavailableCause: WorkflowSecretStoreUnavailableCause;

  constructor(unavailableCause: WorkflowSecretStoreUnavailableCause, keychainMessage: string) {
    super(`The keychain is ${unavailableCause}: ${keychainMessage}`, {
      code: WORKFLOW_SECRET_STORE_UNAVAILABLE_CODE,
      detail: { cause: unavailableCause },
    });
    this.unavailableCause = unavailableCause;
  }
}
