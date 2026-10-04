// SecureDefaults: the validated bootstrap configuration, loaded before any listener binds.
// `effectiveSettings()` throws until `load()` has succeeded. Only `localIpcPath` exists; any
// other key is refused with `unknown_setting`. Socket-path probing belongs to the listener.

/** The bootstrap settings: the OS-local socket or pipe path. */
export interface SecureDefaultsConfig {
  /** Path of the IPC socket or named pipe; only checked to be non-empty here. */
  readonly localIpcPath: string;
}

/**
 * The non-secret view returned by `effectiveSettings()`. It has the config's members; it is kept
 * separate so a secret-bearing setting added to the config never leaks through it.
 */
export interface SecureDefaultsEffectiveSettings {
  readonly localIpcPath: string;
}

// A closed allowlist: a denylist would silently accept any future key.
const KNOWN_KEYS: ReadonlySet<string> = new Set<string>(["localIpcPath"]);

/**
 * Thrown by `SecureDefaults.load` on invalid configuration. `code` is stable and distinct per
 * failure mode; `fields` carries the offending setting and value, which `jsonrpc-error-mapping.ts`
 * projects into `error.data.fields`.
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

// Module singleton, so bootstrap and the gateway share one load state without an instance.
let loadedSettings: SecureDefaultsEffectiveSettings | null = null;

/** Validates the bootstrap configuration once and serves the result to the rest of the daemon. */
export class SecureDefaults {
  // Static-only: a stray `new SecureDefaults()` must not bypass the load gate.
  private constructor() {
    throw new Error("SecureDefaults: use static methods, not `new`");
  }

  /**
   * Validates the configuration and stores the frozen effective view; the latest successful load
   * wins.
   *
   * @throws SecureDefaultsValidationError on invalid input; earlier settings are kept.
   */
  static load(config: SecureDefaultsConfig): void {
    const validated: SecureDefaultsEffectiveSettings = validateConfig(config);
    loadedSettings = Object.freeze(validated);
  }

  /**
   * Returns the validated, frozen, non-secret settings view.
   *
   * @throws Error when no `load()` has succeeded.
   */
  static effectiveSettings(): SecureDefaultsEffectiveSettings {
    if (loadedSettings === null) {
      throw new Error(
        "SecureDefaults.effectiveSettings: SecureDefaults.load(config) must succeed before this view is read",
      );
    }
    return loadedSettings;
  }

  /** True once `load()` has succeeded in this process; lets the bind guard avoid the throw. */
  static isLoaded(): boolean {
    return loadedSettings !== null;
  }
}

function validateConfig(config: SecureDefaultsConfig): SecureDefaultsEffectiveSettings {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new SecureDefaultsValidationError(
      "invalid_config",
      `SecureDefaults.load: config must be an object (got ${describeNonObject(config)})`,
      { value: config },
    );
  }

  // Walk the runtime keys, not the typed shape, so extra keys from untyped callers are caught.
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

  if (!hasOwn(config, "localIpcPath")) {
    throw new SecureDefaultsValidationError(
      "missing_required_setting",
      `SecureDefaults.load: required setting "localIpcPath" is missing`,
      { setting: "localIpcPath" },
    );
  }

  const { localIpcPath } = config;
  if (typeof localIpcPath !== "string" || localIpcPath.length === 0) {
    throw new SecureDefaultsValidationError(
      "invalid_local_ipc_path",
      `SecureDefaults.load: localIpcPath must be a non-empty string (got ${describeValue(localIpcPath)})`,
      { setting: "localIpcPath", value: localIpcPath },
    );
  }

  return { localIpcPath };
}

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
