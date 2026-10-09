// The one place a Claude Code process's environment is composed: the login shell's base with the
// session's environment rows over it, the curated credential variables and the withheld names
// removed, then the variables the app sets on every Claude Code process and the account's folders.

import {
  buildProviderSpawnEnv,
  type ClaudeAccountFolders,
  type SessionEnvironmentRows,
  type SpawnEnvNameMatch,
  type SpawnEnvPair,
} from "../../../spawn-env.js";

/** What one Claude Code process's environment is built from. */
export interface ClaudeSpawnEnvironmentRequest {
  /** The login shell's environment captured at the daemon's start; never `process.env`. */
  readonly providerBaseEnvironment: readonly SpawnEnvPair[];
  /** How this system compares environment variable names. */
  readonly environmentNameMatch: SpawnEnvNameMatch;
  readonly environmentRows: SessionEnvironmentRows | undefined;
  /** Absent, the process runs on the person's own Claude Code home and sign-in. */
  readonly accountFolders: ClaudeAccountFolders | undefined;
}

/**
 * The whole environment a session process, a relaunch or the auth probe starts with; nothing is
 * laid over it later. Throws what `buildProviderSpawnEnv` throws for a conflicting or empty pair.
 */
export function composeClaudeSpawnEnvironment(
  request: ClaudeSpawnEnvironmentRequest,
): readonly SpawnEnvPair[] {
  return buildProviderSpawnEnv({
    driverName: "claude",
    baseEnv: request.providerBaseEnvironment,
    environmentRows: request.environmentRows,
    hostEnvNameMatch: request.environmentNameMatch,
    accountFolders: request.accountFolders,
  });
}
