/**
 * The child-environment builder every provider child spawns through, the version handshake
 * included: strips the credential policy's denied names and always sets the provider's
 * auto-update opt-out.
 *
 * - No `credentialEnvPolicy` (a spawn with no declared posture) strips nothing; the opt-out
 *   always applies.
 * - A policy whose name matching differs from the host's is refused, not reconciled.
 */

import type { ProviderName } from "@ai-sidekicks/contracts/provider/account/account";

import { PROVIDER_DRIVER_DESCRIPTORS } from "./driver/provider-driver-descriptors.js";

/** One child-environment entry, in the pair shape the PTY spawn surface takes. */
export type SpawnEnvPair = readonly [name: string, value: string];

/** How the host compares names; a case-insensitive host lets `path` slip past a deny of `PATH`. */
export type SpawnEnvNameMatch = "case-sensitive" | "case-insensitive";

/** Windows compares names case-insensitively, other targets byte for byte. */
export function hostEnvNameMatchForPlatform(platform: NodeJS.Platform): SpawnEnvNameMatch {
  return platform === "win32" ? "case-insensitive" : "case-sensitive";
}

/** The credential policy as the daemon resolved it from a posture's `credentialPolicyRef`. */
export interface CredentialEnvPolicy {
  readonly denyEnvVars: readonly string[];
  readonly envNameMatch: SpawnEnvNameMatch;
}

/** The inputs to {@link buildProviderSpawnEnv} for one provider spawn. */
export interface ProviderSpawnEnvRequest {
  readonly driverName: ProviderName;
  /** The curated base for this child as pairs; never the daemon's own `process.env`. */
  readonly baseEnv: readonly SpawnEnvPair[];
  /** Every fold keys on it, even without a policy, so a base `disable_updates=0` cannot survive. */
  readonly hostEnvNameMatch: SpawnEnvNameMatch;
  /** Absent for a spawn with no declared posture, which denies nothing. */
  readonly credentialEnvPolicy?: CredentialEnvPolicy | undefined;
  /**
   * Mandated like the opt-out and exempt from the deny strip; a colliding name throws. A driver
   * whose provider has no opt-out pins its build through it.
   */
  readonly additionalMandatedPairs?: readonly SpawnEnvPair[] | undefined;
}

/**
 * Two mandated values claim one name, thrown even for an equal repeat: last-wins could lower an
 * auto-update opt-out and first-wins would drop a pin.
 */
export class ProviderSpawnEnvConflictError extends Error {
  constructor(
    readonly conflictingName: string,
    message: string,
  ) {
    super(message);
    this.name = "ProviderSpawnEnvConflictError";
  }
}

/** The policy's env-name semantics differ from the host's; a wiring fault, not a wire error. */
export class ProviderSpawnEnvNameMatchMismatchError extends Error {
  readonly hostEnvNameMatch: SpawnEnvNameMatch;
  readonly policyEnvNameMatch: SpawnEnvNameMatch;

  constructor(hostEnvNameMatch: SpawnEnvNameMatch, policyEnvNameMatch: SpawnEnvNameMatch) {
    super(
      `credential policy declares '${policyEnvNameMatch}' environment-name matching but this ` +
        `host uses '${hostEnvNameMatch}'; refusing to compose a child environment under ` +
        `semantics the policy was not authored for`,
    );
    this.name = "ProviderSpawnEnvNameMatchMismatchError";
    this.hostEnvNameMatch = hostEnvNameMatch;
    this.policyEnvNameMatch = policyEnvNameMatch;
  }
}

function toMatchKey(name: string, match: SpawnEnvNameMatch): string {
  return match === "case-insensitive" ? name.toUpperCase() : name;
}

/**
 * The base minus denied names, then the mandated pairs; a policy or base value cannot re-enable
 * an auto-updater. Throws {@link ProviderSpawnEnvConflictError} or
 * {@link ProviderSpawnEnvNameMatchMismatchError}.
 */
export function buildProviderSpawnEnv(request: ProviderSpawnEnvRequest): readonly SpawnEnvPair[] {
  // Refuse before folding so a policy authored for another host is never partly applied.
  const nameMatch = request.hostEnvNameMatch;
  const policyNameMatch = request.credentialEnvPolicy?.envNameMatch;
  if (policyNameMatch !== undefined && policyNameMatch !== nameMatch) {
    throw new ProviderSpawnEnvNameMatchMismatchError(nameMatch, policyNameMatch);
  }

  // One pair per name reaches the child; a second claim on a name is refused, not merged.
  const mandatedByKey = new Map<string, SpawnEnvPair>();
  for (const [name, value] of Object.entries(
    PROVIDER_DRIVER_DESCRIPTORS[request.driverName].autoUpdateOptOutEnvironment,
  )) {
    mandatedByKey.set(toMatchKey(name, nameMatch), [name, value]);
  }
  for (const pair of request.additionalMandatedPairs ?? []) {
    const key = toMatchKey(pair[0], nameMatch);
    const declared = mandatedByKey.get(key);
    if (declared !== undefined) {
      throw new ProviderSpawnEnvConflictError(
        pair[0],
        `two mandated spawn-environment values claim the name ${pair[0]}: ` +
          `${declared[0]}=${declared[1]} and ${pair[0]}=${pair[1]}`,
      );
    }
    mandatedByKey.set(key, [pair[0], pair[1]]);
  }

  const deniedKeys = new Set(
    (request.credentialEnvPolicy?.denyEnvVars ?? []).map((name) => toMatchKey(name, nameMatch)),
  );

  const survivors: SpawnEnvPair[] = [];
  for (const [name, value] of request.baseEnv) {
    const key = toMatchKey(name, nameMatch);
    if (deniedKeys.has(key) || mandatedByKey.has(key)) {
      continue;
    }
    survivors.push([name, value]);
  }

  return [...survivors, ...mandatedByKey.values()];
}
