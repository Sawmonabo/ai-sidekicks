// SecureDefaults — daemon bootstrap configuration + enforcement layer.
//
// This is the substrate Plan-007 Tier 1 ships for Spec-027 daemon-side
// secure defaults. It runs as the FIRST step of daemon bootstrap, before
// any listener binds. Downstream daemon modules (gateway, banner,
// supervision) consume `effectiveSettings()` to discover the validated
// non-secret view of the configuration. The orchestrator-throw on
// out-of-order bind attempts (I-007-1) is wired by T-007p-1-3 on top of
// this module's API-internal guard.
//
// Invariants this module enforces (canonical text in
// docs/plans/007-local-ipc-and-daemon-control.md §Invariants lines 61-118):
//   * I-007-1 (load-before-bind, API-internal guard): `effectiveSettings()`
//     throws if called before `load()` resolves.
//   * I-007-2 (fail-closed on invalid security settings, including
//     refuse-unknown-keys with `unknown_setting`).
//   * I-007-3 (`effectiveSettings` exposes only non-secret typed values).
//   * I-007-5 (validation surface widens with bind surface — Tier 1 ships
//     loopback OS-local socket only; Tier-4-scope keys refused).
//
// Spec-027 rows this module covers (canonical text in
// docs/specs/027-self-host-secure-defaults.md §Required Behavior):
//   * Row 4 — loopback bind by default (daemon).
//   * Row 10 — loud first-run banner (daemon content); `effectiveSettings`
//     IS the content contract that the Plan-026-owned banner consumer
//     reads from.
//
// BLOCKED-ON-C6. The config + effective-settings shape below is the
// audit-derived conservative inline contract. When
// docs/architecture/contracts/api-payload-contracts.md §Plan-007 lands
// the authoritative `SecureDefaults` schema, the inline interfaces are
// replaced wholesale by imports from `@ai-sidekicks/contracts` (no
// new abstractions or premature interfaces are introduced here in
// anticipation of that pickup).
//
// What this module does NOT do (deferred):
//   * Port-availability or interface-reachability probing (a listener
//     concern; deferred to T-007p-1-3 / Phase 2 wire substrate).
//   * Override-event emission — owned by `secure-defaults-events.ts`
//     (T-007p-1-2). I-007-4 (single-emit-per-startup) is enforced there.
//   * Tier-4-scope validation (TLS mode, non-loopback bind, first-run
//     keys policy). At Tier 1 those keys are refused with
//     `unknown_setting` per I-007-2 + I-007-5.

// --------------------------------------------------------------------------
// Inline contract types (BLOCKED-ON-C6 — replace with imported types when
// api-payload-contracts.md §Plan-007 lands the authoritative schema).
// --------------------------------------------------------------------------

/**
 * SecureDefaults configuration input. The fields cover the bind paths
 * Tier 1 actually exposes (loopback OS-local socket + banner format);
 * any other key is refused with `unknown_setting` per I-007-5.
 */
export interface SecureDefaultsConfig {
  /**
   * Loopback bind address for the daemon. Tier 1 accepts only the
   * loopback set: `127.0.0.1`, `::1`, `localhost`. Non-loopback values
   * are refused (Tier 4 widens this surface per I-007-5).
   */
  readonly bindAddress: string;

  /**
   * Optional TCP port. When omitted, the daemon listener picks a port
   * (the Tier 1 OS-local socket path may not need a port at all; the
   * field is preserved as optional so Tier 4's HTTP-listener consumer
   * can populate it without a contract-shape amendment).
   */
  readonly bindPort?: number;

  /**
   * Filesystem path for the OS-local IPC socket / named pipe. Validated
   * here only as "non-empty string"; deeper path-shape validation
   * (existence, parent-dir permissions) is a listener concern wired by
   * T-007p-1-3.
   */
  readonly localIpcPath: string;

  /**
   * First-run-banner output format (Spec-027 row 10). `text` is the
   * single-screen stdout default; `json` emits the same payload as a
   * single JSON line for log-formatting environments.
   */
  readonly bannerFormat: "text" | "json";
}

/**
 * Effective-settings view returned by `effectiveSettings()`. Mirrors
 * `SecureDefaultsConfig` minus any future secret-bearing fields per
 * I-007-3 (this module never returns raw keys / secrets). At Tier 1
 * the two shapes are structurally identical because no input field
 * carries a secret; the type is preserved separately so Tier 4 can
 * widen `SecureDefaultsConfig` with secret-bearing fields without
 * leaking them through this view.
 */
export interface SecureDefaultsEffectiveSettings {
  readonly bindAddress: string;
  readonly bindPort?: number;
  readonly localIpcPath: string;
  readonly bannerFormat: "text" | "json";
}

// --------------------------------------------------------------------------
// Allowlists (closed set; widens with bind surface at Tier 4 per I-007-5)
// --------------------------------------------------------------------------

// The KNOWN_KEYS set is the load-bearing enforcement surface for I-007-2's
// refuse-unknown-keys clause. A denylist of the three named Tier-4-scope
// keys (`tlsMode`, `firstRunKeysPolicy`, `nonLoopbackHost`) would silently
// accept any future Tier-4 key added before the corpus catches up; the
// closed allowlist forces every new key through a Tier-1-explicit
// extension here.
const KNOWN_KEYS: ReadonlySet<string> = new Set<string>([
  "bindAddress",
  "bindPort",
  "localIpcPath",
  "bannerFormat",
]);

// Tier 1 scope: loopback-only. Non-loopback (`0.0.0.0`, public addresses,
// hostnames) is refused per I-007-5. Tier 4 widens this set when TLS +
// non-loopback bind paths land (Plan-007-remainder).
const LOOPBACK_BIND_ADDRESSES: ReadonlySet<string> = new Set<string>([
  "127.0.0.1",
  "::1",
  "localhost",
]);

const VALID_BANNER_FORMATS: ReadonlySet<string> = new Set<string>(["text", "json"]);

// --------------------------------------------------------------------------
// Validation error
// --------------------------------------------------------------------------

/**
 * Validation error surface for `SecureDefaults.load`. The string `code`
 * is the stable identifier downstream consumers (and tests) assert on;
 * the JSON-RPC envelope shape that wraps these codes is BLOCKED-ON-C7
 * (error-contracts.md JSON-RPC mapping). Test surface at this task is
 * the `code` field only.
 *
 * Distinct codes per failure mode are kept (rather than collapsing every
 * validation failure to a single `invalid_config`) so downstream
 * observability survives when C-7 lands the envelope shape.
 */
export class SecureDefaultsValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SecureDefaultsValidationError";
    this.code = code;
  }
}

// --------------------------------------------------------------------------
// SecureDefaults — module-singleton state machine
// --------------------------------------------------------------------------
//
// State model: a private module-scoped slot holds the validated effective
// settings (or `null` before `load()`). The class exposes only static
// methods; this matches the plan's `SecureDefaults.load(config)` /
// `SecureDefaults.effectiveSettings()` phrasing and gives every
// downstream consumer (gateway, banner, T-007p-1-3 orchestrator) a
// single import-and-call surface without needing to plumb an instance
// through bootstrap.
//
// The trade-off vs an instance-per-call shape: the singleton requires a
// test-only reset hook (`__resetForTest()`) so each Vitest case starts
// from `loaded === false`. The hook is documented as test-only and
// carries no production callers. The instance-per-call alternative
// would make AC1's "calling effectiveSettings() before load throws"
// trivially compile-time impossible (there's no instance to call
// effectiveSettings on yet), which weakens the runtime guard the plan
// explicitly names as load-bearing.

let loadedSettings: SecureDefaultsEffectiveSettings | null = null;

export class SecureDefaults {
  // Static-only API: prevent accidental instantiation. The constructor
  // is private + throws so a stray `new SecureDefaults()` cannot bypass
  // the load gate.
  private constructor() {
    throw new Error("SecureDefaults: use static methods, not `new`");
  }

  /**
   * Validate the configuration and persist the effective view for
   * downstream consumers. Synchronous — Tier 1 has no I/O (port-bind
   * probes are a listener concern).
   *
   * Idempotency: calling `load()` a second time replaces the previously
   * loaded settings (the orchestrator owns single-call semantics; this
   * module's contract is "the most recent successful load wins").
   *
   * Throws `SecureDefaultsValidationError` (fail-closed per I-007-2) on
   * any validation failure. The previous loaded state, if any, is
   * preserved on failure — a failed reload does not undo a prior
   * successful load.
   */
  static load(config: SecureDefaultsConfig): void {
    const validated: SecureDefaultsEffectiveSettings = validateConfig(config);
    loadedSettings = Object.freeze(validated);
  }

  /**
   * Return the validated, frozen, non-secret effective-settings view.
   * Throws if `load()` has not yet succeeded (API-internal surface of
   * I-007-1; the orchestrator-throw on bind-before-load is wired by
   * T-007p-1-3).
   */
  static effectiveSettings(): SecureDefaultsEffectiveSettings {
    if (loadedSettings === null) {
      throw new Error(
        "SecureDefaults.effectiveSettings: SecureDefaults.load(config) must succeed before this view is read (I-007-1)",
      );
    }
    return loadedSettings;
  }

  /**
   * True iff `load()` has succeeded at least once for the current
   * process. Exposed so the orchestrator (T-007p-1-3) can implement the
   * load-before-bind throw without inspecting module-private state.
   */
  static isLoaded(): boolean {
    return loadedSettings !== null;
  }

  /**
   * Test-only reset hook. Vitest shares a single Node process across
   * cases; without this hook, tests that assert pre-load behavior
   * (W-007p-1-T1) would inherit state from any earlier test that
   * called `load()`. NOT for production use — there is no daemon-
   * runtime caller for this method.
   */
  static __resetForTest(): void {
    loadedSettings = null;
  }
}

// --------------------------------------------------------------------------
// Validation
// --------------------------------------------------------------------------

function validateConfig(config: SecureDefaultsConfig): SecureDefaultsEffectiveSettings {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new SecureDefaultsValidationError(
      "invalid_config",
      `SecureDefaults.load: config must be an object (got ${describeNonObject(config)})`,
    );
  }

  // Refuse-unknown-keys per I-007-2 + I-007-5. Walk the actual input
  // keys (not the typed shape) so Tier-4-scope keys riding through a JS
  // escape hatch are still caught at runtime. The double cast through
  // `unknown` is intentional: `SecureDefaultsConfig` has no index
  // signature, so a direct cast to `Record<string, unknown>` is rejected
  // — but we explicitly want the runtime key set, including any keys
  // outside the typed shape.
  const inputKeys: ReadonlyArray<string> = Object.keys(
    config as unknown as Record<string, unknown>,
  );
  for (const key of inputKeys) {
    if (!KNOWN_KEYS.has(key)) {
      throw new SecureDefaultsValidationError(
        "unknown_setting",
        `SecureDefaults.load: unknown setting "${key}" — Tier 1 validation surface accepts only ${listKeys(KNOWN_KEYS)} (I-007-5)`,
      );
    }
  }

  // Required-key presence (`bindAddress`, `localIpcPath`, `bannerFormat`).
  // `bindPort` is optional per the inline contract.
  if (!hasOwn(config, "bindAddress")) {
    throw new SecureDefaultsValidationError(
      "missing_required_setting",
      `SecureDefaults.load: required setting "bindAddress" is missing`,
    );
  }
  if (!hasOwn(config, "localIpcPath")) {
    throw new SecureDefaultsValidationError(
      "missing_required_setting",
      `SecureDefaults.load: required setting "localIpcPath" is missing`,
    );
  }
  if (!hasOwn(config, "bannerFormat")) {
    throw new SecureDefaultsValidationError(
      "missing_required_setting",
      `SecureDefaults.load: required setting "bannerFormat" is missing`,
    );
  }

  // bindAddress: must be a string in the loopback set.
  const { bindAddress } = config;
  if (typeof bindAddress !== "string" || bindAddress.length === 0) {
    throw new SecureDefaultsValidationError(
      "invalid_bind_address",
      `SecureDefaults.load: bindAddress must be a non-empty string (got ${describeValue(bindAddress)})`,
    );
  }
  if (!LOOPBACK_BIND_ADDRESSES.has(bindAddress)) {
    throw new SecureDefaultsValidationError(
      "invalid_bind_address",
      `SecureDefaults.load: bindAddress "${bindAddress}" is not in the Tier 1 loopback set ${listKeys(LOOPBACK_BIND_ADDRESSES)} — non-loopback bind paths widen at Tier 4 (I-007-5)`,
    );
  }

  // bindPort (optional): if present, must be an integer in [0, 65535].
  // `exactOptionalPropertyTypes` makes `bindPort: undefined` distinct
  // from omission; we treat both as "not provided" since the contract
  // semantically encodes "no port chosen".
  let bindPort: number | undefined;
  if (hasOwn(config, "bindPort") && config.bindPort !== undefined) {
    const candidate: unknown = config.bindPort;
    if (
      typeof candidate !== "number" ||
      !Number.isInteger(candidate) ||
      candidate < 0 ||
      candidate > 65535
    ) {
      throw new SecureDefaultsValidationError(
        "invalid_bind_port",
        `SecureDefaults.load: bindPort must be an integer in [0, 65535] (got ${describeValue(candidate)})`,
      );
    }
    bindPort = candidate;
  }

  // localIpcPath: non-empty string. Deeper path-shape checks are a
  // listener concern (T-007p-1-3 / Phase 2).
  const { localIpcPath } = config;
  if (typeof localIpcPath !== "string" || localIpcPath.length === 0) {
    throw new SecureDefaultsValidationError(
      "invalid_local_ipc_path",
      `SecureDefaults.load: localIpcPath must be a non-empty string (got ${describeValue(localIpcPath)})`,
    );
  }

  // bannerFormat: closed set per Spec-027 row 10.
  const { bannerFormat } = config;
  if (typeof bannerFormat !== "string" || !VALID_BANNER_FORMATS.has(bannerFormat)) {
    throw new SecureDefaultsValidationError(
      "invalid_banner_format",
      `SecureDefaults.load: bannerFormat must be one of ${listKeys(VALID_BANNER_FORMATS)} (got ${describeValue(bannerFormat)})`,
    );
  }

  // Build the validated view. `bindPort` is omitted (not assigned
  // `undefined`) when not provided so the output respects
  // `exactOptionalPropertyTypes` — see the SecureDefaultsEffectiveSettings
  // shape note above.
  if (bindPort !== undefined) {
    return {
      bindAddress,
      bindPort,
      localIpcPath,
      bannerFormat: bannerFormat as "text" | "json",
    };
  }
  return {
    bindAddress,
    localIpcPath,
    bannerFormat: bannerFormat as "text" | "json",
  };
}

// --------------------------------------------------------------------------
// Diagnostic helpers (private)
// --------------------------------------------------------------------------

function hasOwn(obj: SecureDefaultsConfig, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function listKeys(set: ReadonlySet<string>): string {
  return `[${Array.from(set)
    .map((k) => `"${k}"`)
    .join(", ")}]`;
}

function describeNonObject(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

function describeValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value === "string") {
    return `string ${JSON.stringify(value)}`;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return `${typeof value} ${String(value)}`;
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}
