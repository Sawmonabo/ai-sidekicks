// SecureDefaults — daemon bootstrap configuration + enforcement layer.
//
// This is the substrate Tier 1 ships for daemon-side secure defaults. It
// runs as the FIRST step of daemon bootstrap, before any listener binds.
// Downstream daemon modules (gateway, banner, supervision) consume
// `effectiveSettings()` to discover the validated non-secret view of the
// configuration. The orchestrator-throw on out-of-order bind attempts is
// wired on top of this module's API-internal guard.
//
// Invariants this module enforces (canonical text through):
//   * `effectiveSettings()` throws if called before `load()` resolves.
//
// Rows this module covers (canonical text):
//   * Row 4 — loopback bind by default (daemon).
//
// Canonical source: this file. no-mirror disposition, the
// `SecureDefaults` config + effective-settings shape is canonical in
// code does not maintain a doc-side mirror. The interfaces below are
// the authoritative contract for the Tier 1 loopback-bind validation
// surface -remainder widens the surface (Tier 4) by extending the
// schema additively.
//
// What this module does NOT do (deferred):
//   * Port-availability or interface-reachability probing (a listener
//     concern; deferred to Phase 2 wire substrate).
//   * Override-event emission — owned by `secure-defaults-events.ts`.
//   * Tier-4-scope validation (TLS mode, non-loopback bind, first-run
//     keys policy). At Tier 1 those keys are refused with
//     `unknown_setting`.

// --------------------------------------------------------------------------
// Inline contract types — canonical source no-mirror disposition.
// --------------------------------------------------------------------------

/**
 * The fields cover the bind paths Tier 1 actually exposes (loopback
 * OS-local socket + banner format); any other key is refused with
 * `unknown_setting`.
 */
export interface SecureDefaultsConfig {
  /**
   * Loopback bind address for the daemon. Tier 1 accepts only the
   * loopback set: `127.0.0.1`, `::1`, `localhost`. Non-loopback values
   * are refused (Tier 4 widens this surface).
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
   * (existence, parent-dir permissions) is a listener concern wired.
   */
  readonly localIpcPath: string;

  /**
   * First-run-banner output format (row 10). `text` is the
   * single-screen stdout default; `json` emits the same payload as a
   * single JSON line for log-formatting environments.
   */
  readonly bannerFormat: "text" | "json";
}

/**
 * Effective-settings view returned by `effectiveSettings()`. Mirrors
 * `SecureDefaultsConfig` minus any future secret-bearing fields. At
 * Tier 1 the two shapes are structurally identical because no input
 * field carries a secret; the type is preserved separately so Tier 4
 * can widen `SecureDefaultsConfig` with secret-bearing fields
 * without leaking them through this view.
 */
export interface SecureDefaultsEffectiveSettings {
  readonly bindAddress: string;
  readonly bindPort?: number;
  readonly localIpcPath: string;
  readonly bannerFormat: "text" | "json";
}

// --------------------------------------------------------------------------
// Allowlists (closed set; widens with bind surface at Tier 4)
// --------------------------------------------------------------------------

// The KNOWN_KEYS set is the load-bearing enforcement surface for the
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
// hostnames) is refused. Tier 4 widens this set when TLS + non-loopback
// bind paths land (-remainder).
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
 * `fields` carries the structured detail (offending setting name, value)
 * that `mapJsonRpcError` projects into the JSON-RPC envelope's
 * `error.data.fields`.
 *
 * Distinct codes per failure mode are kept (rather than collapsing every
 * validation failure to a single `invalid_config`) so downstream
 * observability discriminates the specific config-validation defect.
 */
export class SecureDefaultsValidationError extends Error {
  readonly code: string;
  readonly fields?: Record<string, unknown>;

  constructor(code: string, message: string, fields?: Record<string, unknown>) {
    super(message);
    this.name = "SecureDefaultsValidationError";
    this.code = code;
    if (fields !== undefined) {
      this.fields = fields;
    }
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
// downstream consumer (gateway, banner orchestrator) a single
// import-and-call surface without needing to plumb an instance through
// bootstrap.
//
// The trade-off vs an instance-per-call shape: the singleton requires a
// test-only reset hook (`__resetForTest()`) so each Vitest case starts
// from `loaded === false`. The hook is documented as test-only and
// carries no production callers. The instance-per-call alternative
// would make the "calling effectiveSettings() before load throws"
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
   * Throws `SecureDefaultsValidationError` (fail-closed) on any
   * validation failure. The previous loaded state, if any, is preserved
   * on failure — a failed reload does not undo a prior successful load.
   */
  static load(config: SecureDefaultsConfig): void {
    const validated: SecureDefaultsEffectiveSettings = validateConfig(config);
    loadedSettings = Object.freeze(validated);
  }

  /**
   * Return the validated, frozen, non-secret effective-settings view.
   * Throws if `load()` has not yet succeeded (API-internal surface of
   * the orchestrator-throw on bind-before-load is wired).
   */
  static effectiveSettings(): SecureDefaultsEffectiveSettings {
    if (loadedSettings === null) {
      throw new Error(
        "SecureDefaults.effectiveSettings: SecureDefaults.load(config) must succeed before this view is read",
      );
    }
    return loadedSettings;
  }

  /**
   * True iff `load()` has succeeded at least once for the current
   * process. Exposed so the orchestrator can implement the
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
      { value: config },
    );
  }

  // Walk the actual input keys (not the typed shape) so Tier-4-scope
  // keys riding through a JS escape hatch are still caught at runtime.
  // The double cast through `unknown` is intentional:
  // `SecureDefaultsConfig` has no index signature, so a direct cast to
  // `Record<string, unknown>` is rejected — but we explicitly want the
  // runtime key set, including any keys outside the typed shape.
  const inputKeys: ReadonlyArray<string> = Object.keys(
    config as unknown as Record<string, unknown>,
  );
  for (const key of inputKeys) {
    if (!KNOWN_KEYS.has(key)) {
      throw new SecureDefaultsValidationError(
        "unknown_setting",
        `SecureDefaults.load: unknown setting "${key}" — Tier 1 validation surface accepts only ${listKeys(KNOWN_KEYS)}`,
        { setting: key, value: (config as unknown as Record<string, unknown>)[key] },
      );
    }
  }

  // Required-key presence (`bindAddress`, `localIpcPath`, `bannerFormat`).
  // `bindPort` is optional per the inline contract.
  if (!hasOwn(config, "bindAddress")) {
    throw new SecureDefaultsValidationError(
      "missing_required_setting",
      `SecureDefaults.load: required setting "bindAddress" is missing`,
      { setting: "bindAddress" },
    );
  }
  if (!hasOwn(config, "localIpcPath")) {
    throw new SecureDefaultsValidationError(
      "missing_required_setting",
      `SecureDefaults.load: required setting "localIpcPath" is missing`,
      { setting: "localIpcPath" },
    );
  }
  if (!hasOwn(config, "bannerFormat")) {
    throw new SecureDefaultsValidationError(
      "missing_required_setting",
      `SecureDefaults.load: required setting "bannerFormat" is missing`,
      { setting: "bannerFormat" },
    );
  }

  // bindAddress: must be a string in the loopback set.
  const { bindAddress } = config;
  if (typeof bindAddress !== "string" || bindAddress.length === 0) {
    throw new SecureDefaultsValidationError(
      "invalid_bind_address",
      `SecureDefaults.load: bindAddress must be a non-empty string (got ${describeValue(bindAddress)})`,
      { setting: "bindAddress", value: bindAddress },
    );
  }
  if (!LOOPBACK_BIND_ADDRESSES.has(bindAddress)) {
    throw new SecureDefaultsValidationError(
      "invalid_bind_address",
      `SecureDefaults.load: bindAddress "${bindAddress}" is not in the Tier 1 loopback set ${listKeys(LOOPBACK_BIND_ADDRESSES)} — non-loopback bind paths widen at Tier 4`,
      { setting: "bindAddress", value: bindAddress },
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
        { setting: "bindPort", value: candidate },
      );
    }
    bindPort = candidate;
  }

  // Deeper path-shape checks are a listener concern.
  const { localIpcPath } = config;
  if (typeof localIpcPath !== "string" || localIpcPath.length === 0) {
    throw new SecureDefaultsValidationError(
      "invalid_local_ipc_path",
      `SecureDefaults.load: localIpcPath must be a non-empty string (got ${describeValue(localIpcPath)})`,
      { setting: "localIpcPath", value: localIpcPath },
    );
  }

  // bannerFormat: closed set row 10.
  const { bannerFormat } = config;
  if (typeof bannerFormat !== "string" || !VALID_BANNER_FORMATS.has(bannerFormat)) {
    throw new SecureDefaultsValidationError(
      "invalid_banner_format",
      `SecureDefaults.load: bannerFormat must be one of ${listKeys(VALID_BANNER_FORMATS)} (got ${describeValue(bannerFormat)})`,
      { setting: "bannerFormat", value: bannerFormat },
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
