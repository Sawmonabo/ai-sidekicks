// Where the service keeps a pasted token, and the pair of lines that names it: one under the
// token field, one when a token registers, which says only that it saved while no place is known.

import type { DaemonSecretsFile } from "@ai-sidekicks/contracts/daemon/status";

/**
 * Where a pasted token is kept: the operating system's keychain, the service's secrets file
 * sealed to this computer, or that file in plain form.
 */
export type SecretsPlace = "keychain" | "sealed" | "plain";

/** The line a registered token settles with while nothing names where the service keeps it. */
export const TOKEN_SAVED_WORDS = "Token saved.";

/** The line under a token field, and the line a registered token settles with, per place. */
export const TOKEN_KEPT_WORDS: Readonly<
  Record<SecretsPlace, { readonly underField: string; readonly saved: string }>
> = {
  keychain: {
    underField: "Stored in this computer's keychain. Never shown again.",
    saved: "Token saved. Stored in the keychain.",
  },
  sealed: {
    underField: "Sealed to this computer. Never shown again.",
    saved: "Token saved. Sealed to this computer.",
  },
  plain: {
    underField: "Stored unencrypted. Only this account can read it.",
    saved: "Token saved. Stored unencrypted.",
  },
};

/**
 * The place `daemon.status.read`'s `secretsFile` names: the keychain where the service names no
 * secrets file, else how that file is protected.
 */
export function secretsPlaceOf(secretsFile: DaemonSecretsFile | undefined): SecretsPlace {
  if (secretsFile === undefined) {
    return "keychain";
  }
  return secretsFile.protection === "plain" ? "plain" : "sealed";
}
