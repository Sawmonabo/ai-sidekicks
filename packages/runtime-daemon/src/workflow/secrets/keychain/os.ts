// The platform keychain behind `SecretKeychain`, through `@napi-rs/keyring`: the macOS login
// keychain, the Windows Credential Manager, and on Linux the Secret Service (GNOME Keyring,
// KWallet, KeePassXC).
//
// On Linux the entry is pinned to the Secret Service, so a machine without one refuses here
// instead of falling back to the kernel keyring, which forgets its keys at reboot; there the
// entries go in the daemon's items file (`file.ts`) instead. A call that does not settle
// in time is abandoned and reported locked, because a keychain waiting on an unlock prompt nobody
// answers never settles.
import { AsyncEntry } from "@napi-rs/keyring";

import type { KeychainRefusalCause } from "@ai-sidekicks/contracts/keychain";

import { WorkflowSecretStoreUnavailableError, type SecretKeychain } from "../store.js";
import { describeRejection } from "../../../rejection.js";

// How long one keychain call may take, an unlock prompt included.
const KEYCHAIN_CALL_TIMEOUT_MS = 30_000;

// The keychain library prefixes its "store refused access" errors, a locked keychain among them,
// with this text; any other failure means the store cannot be used.
const STORAGE_ACCESS_REFUSED_PREFIX = "Couldn't access platform storage";

/** The keychain entries filed under one service name. */
export class OsSecretKeychain implements SecretKeychain {
  readonly #service: string;
  readonly #timeoutMs: number;

  constructor(service: string, timeoutMs: number = KEYCHAIN_CALL_TIMEOUT_MS) {
    this.#service = service;
    this.#timeoutMs = timeoutMs;
  }

  write(account: string, value: string): Promise<void> {
    return this.#call(account, (entry) => entry.setPassword(value));
  }

  async read(account: string): Promise<string | undefined> {
    const value = await this.#call(account, (entry) => entry.getPassword());
    return value ?? undefined;
  }

  remove(account: string): Promise<boolean> {
    return this.#call(account, (entry) => entry.deleteCredential());
  }

  async #call<Result>(
    account: string,
    operation: (entry: AsyncEntry) => Promise<Result>,
  ): Promise<Result> {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new WorkflowSecretStoreUnavailableError(
            "locked",
            `no answer within ${String(this.#timeoutMs)} ms`,
          ),
        );
      }, this.#timeoutMs);
    });
    try {
      const entry = new AsyncEntry(this.#service, account, {
        linux: { store: "secret-service" },
      });
      return await Promise.race([operation(entry), timedOut]);
    } catch (error) {
      if (error instanceof WorkflowSecretStoreUnavailableError) {
        throw error;
      }
      const message = describeRejection(error);
      throw new WorkflowSecretStoreUnavailableError(
        causeOfKeychainFailure(message),
        message,
        error,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

// Maps the library's error message to the cause the store reports.
function causeOfKeychainFailure(message: string): KeychainRefusalCause {
  return message.startsWith(STORAGE_ACCESS_REFUSED_PREFIX) ? "locked" : "unavailable";
}
