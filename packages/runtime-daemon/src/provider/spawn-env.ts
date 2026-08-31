/**
 * The provider-neutral child-environment builder every driver spawns through.
 *
 * ONE POLICY, TWO SHAPES. The daemon owns the environment of every provider
 * process it starts, and that ownership decides exactly two things here: which
 * variables a provider build must NOT see (the effective credential policy's
 * denied names) and which it must ALWAYS see (each provider's documented
 * auto-update opt-out). Both live in this module so a driver cannot answer
 * either question locally. The version-gate's `composeProviderChildEnvironment`
 * applies the opt-out half to a record-shaped environment for its version
 * handshake; this module's {@link buildProviderSpawnEnv} applies both halves to
 * the `[name, value]` pair shape the PTY spawn surface takes. The table below
 * is the single source both read — a second table would be a second answer to a
 * question that has one.
 *
 * WHY THE STRIP LIVES HERE AND NOT IN THE POSTURE. An execution posture carries
 * a content-addressed `credentialPolicyRef`, never the denied names, precisely
 * so a driver never holds the installation's credential inventory. The daemon
 * resolves that reference and hands the RESOLVED `{ denyEnvVars, envNameMatch }`
 * to this builder; no code path in either driver expands a ref, and no code path
 * here invents a name-matching rule — the artifact records the host's env-name
 * case semantics under `envNameMatch`, and this module honours what it is told.
 *
 * ABSENT POLICY IS NOT A LOOSER POLICY. A request with no `credentialEnvPolicy`
 * strips nothing, which is correct: a `trusted` posture carries no policy at
 * all. It never widens the opt-out, which is unconditional on every path.
 *
 * NAME MATCHING IS THE HOST'S, NOT THE POLICY'S. Whether `path` and `PATH` are
 * one variable is a property of the operating system this daemon is running on,
 * so every fold below — the mandated map's keys, the deny set, and the base
 * pruning — keys on the REQUEST's `hostEnvNameMatch`. The credential-policy
 * artifact records the same fact for the host it was authored on, and a policy
 * that disagrees with this host is a wiring fault: it is REFUSED rather than
 * reconciled, because both reconciliations are wrong. Honouring the policy's
 * value would let a case-sensitive artifact leave `path` in the child's
 * environment on a case-insensitive host; honouring the host's value silently
 * would apply a deny list under semantics its author never assumed.
 */

import type { FlooredDriverName } from "./capability-refresh.js";

/** One child-environment entry, in the pair shape the PTY spawn surface takes. */
export type SpawnEnvPair = readonly [name: string, value: string];

/**
 * How the host compares environment-variable names.
 *
 * A property of the operating system, never of a policy: a case-insensitive
 * host would let `path` slip past a deny list that names `PATH`. The
 * credential-policy artifact also records it, for the host it was authored on
 * — see {@link ProviderSpawnEnvNameMatchMismatchError}.
 */
export type SpawnEnvNameMatch = "case-sensitive" | "case-insensitive";

/**
 * The name-matching semantics of the platform this daemon is running on.
 *
 * Windows resolves environment-variable names case-insensitively; every
 * platform this daemon targets otherwise compares them byte-for-byte. Exported
 * so every spawn site derives the value from one place rather than restating a
 * platform test, and takes the platform as an argument — rather than reading
 * `process.platform` itself — so the Windows shape is reachable from a suite
 * running anywhere, which is the neighbouring `resolveExecutableResolver`
 * idiom.
 */
export function hostEnvNameMatchForPlatform(platform: NodeJS.Platform): SpawnEnvNameMatch {
  return platform === "win32" ? "case-insensitive" : "case-sensitive";
}

/**
 * The credential policy AS RESOLVED by the daemon — the expansion of a posture's
 * `credentialPolicyRef`, never the reference itself.
 */
export interface CredentialEnvPolicy {
  readonly denyEnvVars: readonly string[];
  readonly envNameMatch: SpawnEnvNameMatch;
}

/**
 * The documented auto-update opt-out each provider's child environment carries
 * (`Spec-005 §Required Behavior`, 2026-08-26).
 *
 * Suppression is a CORRECTNESS obligation, not hygiene: a build that replaces
 * itself mid-session invalidates the version recorded on the run's binding AND
 * the capability snapshot the run was admitted against, because neither
 * describes the process that is still executing.
 *
 * TOTAL over `FlooredDriverName`, and the empty Codex entry is a DECLARATION
 * rather than an omission — the same doctrine the per-driver capability tables
 * use. codex-cli documents no environment opt-out, so it reaches the same
 * guarantee the spec's fallback names: the driver resolves and spawns an EXACT
 * BUILD PATH rather than a floating launcher, which the version gate's
 * `resolveProviderExecutable` is. An omitted key and a deliberately-empty one
 * must never look alike.
 *
 * Nothing is invented for the empty entry. A guessed variable name would be
 * indistinguishable in the child from a real one, so a later reader could not
 * tell an enforced opt-out from a decorative one.
 */
export const PROVIDER_AUTO_UPDATE_OPT_OUT_ENV: Readonly<
  Record<FlooredDriverName, Readonly<Record<string, string>>>
> = Object.freeze({
  // Presence-style gates on the pinned build
  // (`docs/reference/provider-wire/claude.md`).
  claude: Object.freeze({ DISABLE_AUTOUPDATER: "1", DISABLE_UPDATES: "1" }),
  codex: Object.freeze({}),
});

export interface ProviderSpawnEnvRequest {
  readonly driverName: FlooredDriverName;
  /**
   * The curated base the daemon composed for this child — `{...curatedBase,
   * ...runProvisionedVars}` already flattened to pairs. NEVER the daemon's own
   * `process.env`: this builder prunes and adds, and a caller that hands it
   * ambient inheritance has already lost the property the pruning protects.
   */
  readonly baseEnv: readonly SpawnEnvPair[];
  /**
   * How THIS host compares environment-variable names — normally
   * {@link hostEnvNameMatchForPlatform} of the running platform.
   *
   * REQUIRED, and the single rule every fold here keys on. It was previously
   * read off the credential policy, which meant a `trusted` posture (no policy
   * at all) silently folded case-sensitively on Windows: a base
   * `disable_updates=0` would survive beside the mandated `DISABLE_UPDATES=1`
   * and the child would receive both, with the winner chosen by whatever
   * finally execs the process — the exact outcome the REPLACE-NOT-APPEND rule
   * exists to prevent.
   */
  readonly hostEnvNameMatch: SpawnEnvNameMatch;
  /** Absent under a `trusted` posture, which denies nothing. */
  readonly credentialEnvPolicy?: CredentialEnvPolicy | undefined;
  /**
   * Per-connection variables that are mandated exactly like the table's, and so
   * are STRIP-EXEMPT: they are the daemon's own instructions to the child, not
   * inherited state a policy is entitled to remove.
   *
   * The Codex binary path is the load-bearing case. It is what makes that
   * provider's empty opt-out entry safe — it pins the exact build the child
   * executes — so a deny list that could strip it would defeat the very fallback
   * the empty entry relies on. Per-connection rather than table-resident because
   * the path is resolved at connection time, which a static table cannot hold.
   *
   * STRIP-EXEMPT IS NOT OVERRIDE-CAPABLE: a name here that collides with the
   * driver's declared opt-out — or with another entry in this same array — is
   * refused, never merged. See {@link ProviderSpawnEnvConflictError}.
   */
  readonly additionalMandatedPairs?: readonly SpawnEnvPair[] | undefined;
}

/**
 * A caller supplied two mandated values for one environment-variable name.
 *
 * Thrown rather than resolved, because every resolution rule available here is
 * wrong. Last-wins would let a per-connection pair quietly lower a provider's
 * auto-update opt-out, which is the one value this module exists to make
 * non-negotiable; first-wins would silently discard a per-connection pin the
 * caller believes it set. A collision is a defect at a daemon-internal call
 * site — never reachable from session input — so failing loudly at construction
 * is strictly better than shipping a child environment nobody chose.
 *
 * The refusal is uniform: a colliding restatement of the SAME value is refused
 * too. An exemption for matching values would key on the value rather than on
 * the question actually being asked — whether two places claim authority over
 * one name — and would let a later edit to either side turn a passing call into
 * a silent override.
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

/**
 * The resolved credential policy claims different env-name semantics than the
 * host this daemon is running on.
 *
 * A daemon-internal WIRING fault, never reachable from session input: the
 * policy artifact and the platform test describe the same host, so a
 * disagreement means the policy was resolved for a different one. Thrown rather
 * than reconciled because neither reconciliation is defensible — see the module
 * header — and silence here would produce a child environment whose deny list
 * was applied under semantics its author did not assume.
 *
 * Module-local, like {@link ProviderSpawnEnvConflictError}: there is no wire
 * surface a caller could reach this through, so it carries no registered error
 * code and mints nothing.
 */
export class ProviderSpawnEnvNameMatchMismatchError extends Error {
  readonly hostEnvNameMatch: SpawnEnvNameMatch;
  readonly policyEnvNameMatch: SpawnEnvNameMatch;

  constructor(hostEnvNameMatch: SpawnEnvNameMatch, policyEnvNameMatch: SpawnEnvNameMatch) {
    super(
      `credential policy declares '${policyEnvNameMatch}' environment-name matching but this host uses '${hostEnvNameMatch}'; refusing to compose a child environment under semantics the policy was not authored for`,
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
 * Compose the complete child environment for one provider spawn.
 *
 * STRIP, THEN SET — and the order is the specification, not an implementation
 * detail. The mandated pairs are applied after the deny strip, so a policy that
 * names `DISABLE_AUTOUPDATER` cannot re-enable a provider auto-updater
 * underneath a running driver, and neither can a curated base that carries
 * `DISABLE_AUTOUPDATER=0`.
 *
 * REPLACE, NOT APPEND. A mandated name is removed from the base before its own
 * pair is appended, rather than appended beside it. Duplicate names in a spawn
 * environment resolve at the discretion of whatever finally execs the process,
 * so a builder that appended would be handing that decision away — and the
 * whole point of the opt-out is that its value is not up for negotiation.
 *
 * Base ORDER is preserved and nothing is sorted: the return value is the base
 * minus what was removed, then the mandated pairs. A caller asserting on the
 * exact array sees a stable, explainable shape.
 *
 * @throws {ProviderSpawnEnvConflictError} when two mandated pairs claim one name.
 * @throws {ProviderSpawnEnvNameMatchMismatchError} when a supplied credential
 *   policy declares different env-name semantics than the host.
 */
export function buildProviderSpawnEnv(request: ProviderSpawnEnvRequest): readonly SpawnEnvPair[] {
  // FIRST, before any folding: a policy authored for another host's semantics
  // is refused rather than partially applied. Checking after a fold would mean
  // the refusal came from a builder that had already keyed a map the wrong way.
  const nameMatch = request.hostEnvNameMatch;
  const policyNameMatch = request.credentialEnvPolicy?.envNameMatch;
  if (policyNameMatch !== undefined && policyNameMatch !== nameMatch) {
    throw new ProviderSpawnEnvNameMatchMismatchError(nameMatch, policyNameMatch);
  }

  // Exactly one pair per name reaches the child, and a second claim on a name is
  // refused rather than merged — the value of a mandated variable is decided in
  // one place or the map would be answering a question it cannot answer.
  const mandatedByKey = new Map<string, SpawnEnvPair>();
  for (const [name, value] of Object.entries(
    PROVIDER_AUTO_UPDATE_OPT_OUT_ENV[request.driverName],
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
