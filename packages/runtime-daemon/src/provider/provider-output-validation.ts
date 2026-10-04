// Validation for provider-declared strings that cross into local SQLite, on top of the SQL CHECK
// constraints in `session/daemon-schema.ts`. The bounds govern both `runtime_bindings` and
// `driver_contract_meta`, so they live here once. Every rejection is a
// `ProviderOutputValidationError`, never a raw Zod or SQLite error.

import { DRIVER_CAPABILITY_FLAGS } from "@ai-sidekicks/contracts/provider-driver";
import { DRIVER_WIRE_CONTRACT_VERSION_MAX_LEN } from "@ai-sidekicks/contracts/provider-driver-wire";
import { wireFreeFormString } from "@ai-sidekicks/contracts/session";
import type { ProviderName } from "@ai-sidekicks/contracts/provider-account";
import semver from "semver";

import type { DriverCliVersionReport } from "./provider-driver.js";
import { isPlainObject } from "./record-readers.js";

/** Maximum length of a provider-owned opaque `resume_handle`; equals the SQL CHECK bound. */
export const RESUME_HANDLE_MAX_LEN = 4096;

/**
 * Maximum length of `DriverCliVersionReport.rawVersion`; equals the SQL CHECK bound. SQLite counts
 * characters and Zod counts UTF-16 code units, which is safe because Zod is the stricter layer.
 */
const CLI_VERSION_RAW_MAX_LEN = 128;

/** Maximum length of `DriverCliVersionReport.parsedVersion`; equals the SQL CHECK bound. */
const CLI_VERSION_SEMVER_MAX_LEN = 64;

/**
 * Thrown when a provider-declared output field fails write-seam validation. It has no dotted
 * `code`, so it never reaches the wire as a typed envelope, and the offending value never enters
 * `fields` because it is provider-supplied and may be large or sensitive.
 */
export class ProviderOutputValidationError extends Error {
  readonly fields?: Record<string, unknown>;

  constructor(message: string, fields?: Record<string, unknown>) {
    super(message);
    this.name = "ProviderOutputValidationError";
    if (fields !== undefined) {
      this.fields = fields;
    }
  }
}

// `semver.valid` is lenient (it accepts `v1.2.3` and " 1.2.3 " and strips build metadata), so the
// `=== value` check rejects non-canonical strings instead of normalizing them. Build metadata
// does not identify a version; storing two builds as different values would fake a change.
const contractVersionSchema = wireFreeFormString(
  DRIVER_WIRE_CONTRACT_VERSION_MAX_LEN,
  "contract_version",
).refine((value) => semver.valid(value) === value, {
  message:
    "contract_version must be a canonical, identifying semver string (no build metadata; " +
    "SemVer section 10 build metadata is non-identifying and is rejected from this identity " +
    "field).",
});

// Rejects whitespace-only handles, which the SQL CHECK would accept.
const resumeHandleSchema = wireFreeFormString(RESUME_HANDLE_MAX_LEN, "resume_handle");

// The storage bounds of a version report; the parse itself is `parseCliVersionReport`'s.
const cliVersionRawSchema = wireFreeFormString(CLI_VERSION_RAW_MAX_LEN, "cli_version_raw");
const cliVersionSemverSchema = wireFreeFormString(
  CLI_VERSION_SEMVER_MAX_LEN,
  "cli_version_semver",
).refine((value) => semver.valid(value) === value, {
  message:
    "cli_version_semver must be a canonical semver string within length bounds " +
    "(the exact form `semver.valid` returns)",
});

/** Validates a provider-declared `contract_version`; throws `ProviderOutputValidationError`. */
export function assertValidContractVersion(value: string): void {
  const result = contractVersionSchema.safeParse(value);
  if (!result.success) {
    throw new ProviderOutputValidationError("Invalid provider contract_version.", {
      field: "contract_version",
      reason:
        "must be a canonical, identifying semver string within length bounds " +
        "(no build metadata; SemVer section 10 build metadata is non-identifying and is rejected)",
    });
  }
}

/** Validates a non-null `resume_handle`; throws `ProviderOutputValidationError`. */
export function assertValidResumeHandle(value: string): void {
  const result = resumeHandleSchema.safeParse(value);
  if (!result.success) {
    throw new ProviderOutputValidationError("Invalid provider resume_handle.", {
      field: "resume_handle",
      reason: "must be a non-empty, non-whitespace, NUL-free string within length bounds",
    });
  }
}

/**
 * Validates a `DriverCliVersionReport` against the storage bounds, once, where the daemon reads
 * the version off the spawned build; the capability writer and the binding store trust the typed
 * report after that. Throws `ProviderOutputValidationError` naming `driverName` but never the
 * values, since a raw CLI version can carry an install path.
 */
export function assertValidCliVersionReport(
  driverName: ProviderName,
  report: DriverCliVersionReport,
): void {
  if (!cliVersionRawSchema.safeParse(report.rawVersion).success) {
    throw new ProviderOutputValidationError("Invalid provider cli_version report.", {
      driverName,
      field: "cli_version_raw",
      reason: "must be a non-empty, non-whitespace, NUL-free string within length bounds",
    });
  }
  if (
    report.parsedVersion !== undefined &&
    !cliVersionSemverSchema.safeParse(report.parsedVersion).success
  ) {
    throw new ProviderOutputValidationError("Invalid provider cli_version report.", {
      driverName,
      field: "cli_version_semver",
      reason: "must be a canonical, NUL-free semver string within length bounds",
    });
  }
}

/**
 * Shape guard for a provider-declared `GetCapabilitiesResult`; throws
 * `ProviderOutputValidationError`. It checks only what `DriverCapabilitiesWriter.declare`
 * dereferences at once; flags, version and tool entries keep their own validators.
 */
export function assertValidGetCapabilitiesResultShape(result: unknown): void {
  if (!isPlainObject(result)) {
    throw new ProviderOutputValidationError("Invalid provider capability result.", {
      field: "result",
      reason: "result must be an object",
    });
  }
  const capabilities = result["capabilities"];
  if (!isPlainObject(capabilities)) {
    throw new ProviderOutputValidationError("Invalid provider capability result.", {
      field: "capabilities",
      reason: "capabilities must be an object",
    });
  }
  const tools = result["tools"];
  if (!Array.isArray(tools)) {
    throw new ProviderOutputValidationError("Invalid provider capability result.", {
      field: "tools",
      reason: "tools must be an array",
    });
  }
  // A hole passes `Array.isArray` but the later insert loop would yield `undefined` for it and
  // throw a raw TypeError inside an open transaction.
  for (let index = 0; index < tools.length; index += 1) {
    if (!(index in tools)) {
      throw new ProviderOutputValidationError("Invalid provider capability result.", {
        field: "tools",
        reason: "tools must be a dense array (sparse holes are not permitted)",
      });
    }
  }
}

/**
 * Validates a capability `flags` map; throws `ProviderOutputValidationError`. It must hold
 * exactly `DRIVER_CAPABILITY_FLAGS` as own boolean keys, because an extra key would hit the SQL
 * CHECK mid-transaction and an inherited flag beside a typo'd key would pass a prototype lookup.
 */
export function assertValidCapabilityFlags(flags: unknown): void {
  if (!isPlainObject(flags)) {
    throw new ProviderOutputValidationError("Invalid driver capability flags.", {
      field: "flags",
      reason: "flags must be an object",
    });
  }
  const keys = Object.keys(flags);
  if (keys.length !== DRIVER_CAPABILITY_FLAGS.length) {
    throw new ProviderOutputValidationError("Invalid driver capability flags.", {
      field: "flags",
      reason:
        `must declare exactly the ${DRIVER_CAPABILITY_FLAGS.length.toString()} canonical ` +
        `capability flags`,
    });
  }
  for (const flag of DRIVER_CAPABILITY_FLAGS) {
    if (!Object.prototype.hasOwnProperty.call(flags, flag) || typeof flags[flag] !== "boolean") {
      throw new ProviderOutputValidationError("Invalid driver capability flags.", {
        field: "flags",
        reason: "each canonical capability flag must be present and boolean",
      });
    }
  }
}
