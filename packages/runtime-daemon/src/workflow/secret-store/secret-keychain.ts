// The seam between the workflow-secret store and the operating system's keychain.
//
// The store holds no keychain code: it takes a `SecretKeychain`, and the one
// implementation over the platform keychain lives beside it in
// `os-secret-keychain.ts`. So the store's rules are tested without touching the
// person's keychain, and the native keychain binding stays out of every module that
// only needs the store's shape.
import {
  WORKFLOW_SECRET_STORE_UNAVAILABLE_CODE,
  type WorkflowSecretStoreUnavailableCause,
} from "@ai-sidekicks/contracts";

import { DaemonDomainError } from "../../ipc/domain-error.js";

/**
 * One keychain service's entries, each addressed by an account name. Every method
 * settles within a bounded time: a keychain that is locked, missing or does not answer
 * rejects with {@link WorkflowSecretStoreUnavailableError}.
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
 * The keychain could not be used: it is locked, or this machine has none the daemon can
 * use. Projects to `workflow.secret_store_unavailable` with its cause. The message
 * carries the keychain's own report of the failure; the value is never passed to it.
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
