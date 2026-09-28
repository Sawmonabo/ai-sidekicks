// SecureDefaults — daemon bootstrap configuration + enforcement layer.
//
// This is the substrate this package ships for daemon-side secure defaults. It
// runs as the FIRST step of daemon bootstrap, before any listener binds.
// Downstream daemon modules (gateway, banner, supervision) consume
// `effectiveSettings()` to discover the validated non-secret view of the
// configuration. The orchestrator-throw on out-of-order bind attempts is
// wired on top of this module's API-internal guard.
//
// Invariants this module enforces:
//   * `effectiveSettings()` throws if called before `load()` resolves.
//
// The daemon binds only its OS-local socket or named pipe; `/metrics` is the
// one network listener.
//
// What this module does NOT do:
//   * Socket-path probing (a listener concern).
//   * Override-event emission — owned by `secure-defaults-events.ts`.
//   * Any other setting (TLS mode, a network bind address, first-run keys
//     policy): those keys are refused with `unknown_setting`.

// --------------------------------------------------------------------------
// Settings types
// --------------------------------------------------------------------------

/**
 * The bootstrap settings: the OS-local socket or pipe path and the banner
 * format. Any other key is refused with `unknown_setting`.
 */
export interface SecureDefaultsConfig {
  /**
   * Filesystem path for the OS-local IPC socket / named pipe. Validated
   * here only as "non-empty string"; deeper path-shape validation
   * (existence, parent-dir permissions) is the listener's concern.
   */
  readonly localIpcPath: string;

  /**
   * First-run-banner output format. `text` is the
   * single-screen stdout default; `json` emits the same payload as a
   * single JSON line for log-formatting environments.
   */
  readonly bannerFormat: "text" | "json";
}

/**
 * Effective-settings view returned by `effectiveSettings()`: the non-secret
 * view of `SecureDefaultsConfig`. The two shapes are structurally identical
 * because no input field carries a secret; the type stays separate so a
 * secret-bearing setting never leaks through this view.
 */
export interface SecureDefaultsEffectiveSettings {
  readonly localIpcPath: string;
  readonly bannerFormat: "text" | "json";
}

// --------------------------------------------------------------------------
// Allowlists (closed sets)
// --------------------------------------------------------------------------

// The KNOWN_KEYS set is the load-bearing enforcement surface for the
// refuse-unknown-keys clause. A denylist of the three named extended-scope
// keys (`tlsMode`, `firstRunKeysPolicy`, `nonLoopbackHost`) would silently
// accept any future extended-scope key added before the corpus catches up; the
// closed allowlist forces every new key through an explicit extension here.
const KNOWN_KEYS: ReadonlySet<string> = new Set<string>(["localIpcPath", "bannerFormat"]);

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
   * downstream consumers. Synchronous — there is no I/O (socket
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
   * (its test) would inherit state from any earlier test that
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

  // Walk the actual input keys (not the typed shape) so extended-scope
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
        `SecureDefaults.load: unknown setting "${key}" — the validation surface accepts only ${listKeys(KNOWN_KEYS)}`,
        { setting: key, value: (config as unknown as Record<string, unknown>)[key] },
      );
    }
  }

  // Required-key presence (`localIpcPath`, `bannerFormat`).
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

  // Deeper path-shape checks are a listener concern.
  const { localIpcPath } = config;
  if (typeof localIpcPath !== "string" || localIpcPath.length === 0) {
    throw new SecureDefaultsValidationError(
      "invalid_local_ipc_path",
      `SecureDefaults.load: localIpcPath must be a non-empty string (got ${describeValue(localIpcPath)})`,
      { setting: "localIpcPath", value: localIpcPath },
    );
  }

  // bannerFormat: a closed set.
  const { bannerFormat } = config;
  if (typeof bannerFormat !== "string" || !VALID_BANNER_FORMATS.has(bannerFormat)) {
    throw new SecureDefaultsValidationError(
      "invalid_banner_format",
      `SecureDefaults.load: bannerFormat must be one of ${listKeys(VALID_BANNER_FORMATS)} (got ${describeValue(bannerFormat)})`,
      { setting: "bannerFormat", value: bannerFormat },
    );
  }

  return {
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
