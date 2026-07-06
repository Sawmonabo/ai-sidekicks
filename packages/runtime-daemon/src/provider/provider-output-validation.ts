// Provider-output write-seam validation (Plan-005 Phase 2).
//
// Single source of truth for the bounds applied to PROVIDER-DECLARED strings at
// the moment they cross into durable Local SQLite storage. This is
// DEFENSE-IN-DEPTH layered on top of the SQLite CHECK constraints shipped in
// `migrations/0003-runtime-bindings.ts` (Plan-005 T2.1) — NOT a contract-layer
// schema. `packages/contracts/src/provider-driver.ts` deliberately does NOT
// re-parse these fields; it documents that they are "bounded at the Plan-005
// Phase-2 write seam", and THIS module is that seam.
//
// Why a shared module (not inlined into RuntimeBindingStore):
//   The same bounds govern two provider-output columns with identical SQL
//   CHECKs — `runtime_bindings.contract_version` (T2.2, this task) AND
//   `driver_contract_meta.contract_version` (T2.4). Centralizing the bounds +
//   the assert functions here means the const↔Zod↔SQL-CHECK coherence is
//   asserted in ONE place and reused, rather than drifting across two call
//   sites.
//
// Spec coverage: Spec-005:55 (resume_handle is a provider-owned opaque handle,
// bounded at the write seam).
//
// Refs: Plan-005 §Phase 2 / T2.2 + T2.4, Spec-005 line 55.

import { DRIVER_CAPABILITY_FLAGS, wireFreeFormString } from "@ai-sidekicks/contracts";
import semver from "semver";

// --------------------------------------------------------------------------
// Canonical length bounds — lockstep with the SQL CHECK literals.
// --------------------------------------------------------------------------

/**
 * Maximum length of a provider-declared `contract_version`.
 *
 * MUST stay in lockstep with the `length(contract_version) <= 64` SQL CHECK
 * literal in `migrations/0003-runtime-bindings.ts` on BOTH
 * `runtime_bindings.contract_version` AND `driver_contract_meta.contract_version`.
 * The boundary tests in `__tests__/runtime-binding-store.test.ts` ENFORCE this
 * coherence end-to-end: a `CONTRACT_VERSION_MAX_LEN`-length value is INSERTed
 * through the real DB, so if this const were ever bumped ABOVE the SQL CHECK
 * literal, the const-length fixture would pass the Zod layer but the DB CHECK
 * would reject it and the test would fail. The coherence is therefore a
 * tested property, not just this comment.
 */
export const CONTRACT_VERSION_MAX_LEN = 64;

/**
 * Maximum length of a provider-owned opaque `resume_handle`.
 *
 * MUST stay in lockstep with the `length(resume_handle) <= 4096` SQL CHECK
 * literal in `migrations/0003-runtime-bindings.ts` on
 * `runtime_bindings.resume_handle`. Enforced end-to-end by the boundary tests
 * (same mechanism as `CONTRACT_VERSION_MAX_LEN` above).
 */
export const RESUME_HANDLE_MAX_LEN = 4096;

// --------------------------------------------------------------------------
// Typed error
// --------------------------------------------------------------------------

/**
 * Thrown when a provider-declared output field fails write-seam validation.
 *
 * Mirrors the daemon typed-error convention (`SessionNotFoundError`): a stable
 * `code` literal in the `driver.*` dotted namespace (consistent with T2.3's
 * `driver.capability_unsupported`, reusable by T2.4) and an optional `fields`
 * carrying STRUCTURED throw-site detail — `{ field, reason }`.
 *
 * Deliberately leak-safe: the message is a short stable sentence and the
 * `fields` carry only `field` (which column) + `reason` (a human label). We do
 * NOT embed raw `ZodError` internals, stack traces, or the offending value's
 * full contents — the offending value is provider-supplied and may be large or
 * sensitive (an opaque resume handle), so it never enters the error surface.
 */
export class ProviderOutputValidationError extends Error {
  readonly code = "driver.provider_output_invalid" as const;
  readonly fields?: Record<string, unknown>;

  constructor(message: string, fields?: Record<string, unknown>) {
    super(message);
    this.name = "ProviderOutputValidationError";
    if (fields !== undefined) {
      this.fields = fields;
    }
  }
}

// --------------------------------------------------------------------------
// Prepared schemas (composed once at module load).
// --------------------------------------------------------------------------

// `wireFreeFormString` layers `.min(1)` + `.max(maxLen)` + `/\S/`
// (whitespace-only rejection) + NUL-byte rejection. For `contract_version` we
// then add the canonical-identity semver refinement below.
//
// The `semver.valid(v) === v` (canonical-identity) check is deliberate and
// load-bearing — verified empirically against semver 7.7.4:
//
//   * `semver.valid()` is LENIENT. It ACCEPTS `v1.2.3` (v-prefix), `" 1.2.3 "`
//     (surrounding whitespace), and STRIPS build metadata
//     (`"1.2.3+build.5"` → `"1.2.3"`). A bare `!== null` check would admit all
//     of those NON-canonical strings into the DB.
//   * `=== v` is fail-closed canonical-identity. It ACCEPTS `1.2.3`, `1.0.0`,
//     `2.1.0-rc.1`, `1.0.0-alpha.1` (canonical, incl. prerelease); it REJECTS
//     `1.0`, `1`, `01.2.3` (malformed), `v1.2.3`, `" 1.2.3 "` (loose), and
//     `1.2.3+build.5` (build metadata — per SemVer §10 build metadata is
//     NON-identifying, so we reject it from a contract-*identity* field rather
//     than silently stripping it). Rejecting (not normalizing) keeps the stored
//     value BYTE-IDENTICAL to what passed validation — no transform, no
//     mutation of provider data.
//
// The build-metadata rejection is a DOCUMENTED CONTRACT RULE, not an incidental
// side effect of `semver.valid`: `contract_version` is a canonical, IDENTIFYING
// semver string. Accepting `1.2.3+build.5` and `1.2.3+build.6` as DISTINCT
// stored values would spuriously fire `runtime_node.capability_updated` on a
// non-change (SemVer §10 says they denote the SAME version) — the same defect
// class as the tool-sort canonical-ordering guard. See the matching note in
// docs/architecture/schemas/local-sqlite-schema.md (`driver_contract_meta` /
// `runtime_bindings` `contract_version` columns).
//
// This is why the refinement is `semver.valid(v) === v` and not `!== null`.
const contractVersionSchema = wireFreeFormString(
  CONTRACT_VERSION_MAX_LEN,
  "contract_version",
).refine((value) => semver.valid(value) === value, {
  message:
    "contract_version must be a canonical, identifying semver string (no build metadata; " +
    "SemVer §10 build metadata is non-identifying and is rejected from this identity field).",
});

// `wireFreeFormString`'s `/\S/` adds an ALL-WHITESPACE rejection BEYOND the DB
// CHECK's length+NUL bounds — a deliberate hardening for an opaque handle (an
// all-whitespace handle is non-empty and NUL-free, so the SQL CHECK would
// accept it, but it can never be a meaningful provider handle).
const resumeHandleSchema = wireFreeFormString(RESUME_HANDLE_MAX_LEN, "resume_handle");

// --------------------------------------------------------------------------
// Assert functions
// --------------------------------------------------------------------------

/**
 * Validate a provider-declared `contract_version` at the write seam. Throws
 * `ProviderOutputValidationError` on failure.
 *
 * Uses `safeParse` (NOT `.parse()`, which throws a raw `ZodError`) so the only
 * error a caller ever sees is the leak-safe `ProviderOutputValidationError`.
 */
export function assertValidContractVersion(value: string): void {
  const result = contractVersionSchema.safeParse(value);
  if (!result.success) {
    throw new ProviderOutputValidationError("Invalid provider contract_version.", {
      field: "contract_version",
      reason:
        "must be a canonical, identifying semver string within length bounds " +
        "(no build metadata; SemVer §10 build metadata is non-identifying and is rejected)",
    });
  }
}

/**
 * Validate a NON-NULL provider-owned `resume_handle` at the write seam. Throws
 * `ProviderOutputValidationError` on failure.
 *
 * The `resume_handle` column is NULLABLE; callers invoke this ONLY when a handle
 * is present. NULL/absence is a valid state and is never routed here.
 */
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
 * STRUCTURAL shape guard for a provider-declared `GetCapabilitiesResult` at the
 * write seam. Throws `ProviderOutputValidationError` on failure.
 *
 * `DriverCapabilitiesWriter.declare` dereferences `result.capabilities.<...>`
 * and `result.tools.map(...)` immediately. The static `GetCapabilitiesResult`
 * type is erased at runtime, so a malformed driver can ship `result`,
 * `result.capabilities`, or `result.tools` as null/array/primitive — and those
 * raw dereferences would throw a TypeError, escaping this module's leak-safe
 * doctrine (rejected/invalid input surfaces ONLY `ProviderOutputValidationError`
 * and NEVER opens a transaction). This guard checks EXACTLY the three accesses
 * `declare` already makes — it is BOUNDED:
 *   * `result` is a non-null, non-array object,
 *   * `result.capabilities` is a non-null, non-array object,
 *   * `result.tools` is a DENSE Array (no sparse holes — so the downstream `.map` cannot silently skip a hole and the in-txn insert loop cannot dereference an undefined hole).
 * It deliberately does NOT re-parse `capabilities.flags` /
 * `capabilities.contractVersion` / each tool entry — those keep their dedicated
 * downstream validators (`assertValidCapabilityFlags`,
 * `assertValidContractVersion`, `ProviderToolMetadataSchema.safeParse`). Full
 * value-normalization stays the Phase-3 driver adapter's job (see this module's
 * header / provider-driver.ts §1(b) boundary). Structural shape-guarding so no
 * raw error escapes is THIS seam's job; value-normalization is NOT.
 */
export function assertValidGetCapabilitiesResultShape(result: unknown): void {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new ProviderOutputValidationError("Invalid provider capability result.", {
      field: "result",
      reason: "result must be an object",
    });
  }
  const resultRecord = result as Record<string, unknown>;
  const capabilities = resultRecord["capabilities"];
  if (typeof capabilities !== "object" || capabilities === null || Array.isArray(capabilities)) {
    throw new ProviderOutputValidationError("Invalid provider capability result.", {
      field: "capabilities",
      reason: "capabilities must be an object",
    });
  }
  const tools = resultRecord["tools"];
  if (!Array.isArray(tools)) {
    throw new ProviderOutputValidationError("Invalid provider capability result.", {
      field: "tools",
      reason: "tools must be an array",
    });
  }
  // Reject SPARSE arrays (holes). `Array.isArray` is true for `[ , x]`, but the
  // `declare` path `.map`s the tools (which SKIPS holes, leaving them in the
  // normalized array) and the in-txn insert loop then iterates with `for...of`
  // (which does NOT skip holes — it yields `undefined`), so a hole would
  // dereference `undefined.name` as a raw TypeError from INSIDE an already-opened
  // transaction — violating both the "never open a txn on rejected input" and the
  // "leak-safe ProviderOutputValidationError, never a raw error" doctrines.
  // `index in tools` is the precise hole test (false for a hole, true for an
  // explicitly-set index, even one whose value is undefined). Asserting density
  // HERE makes this guard's "tools is a well-formed array" contract literally true.
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
 * Validate a provider-declared capability `flags` map at the write seam. Throws
 * `ProviderOutputValidationError` on failure.
 *
 * This guards T2.4's OWN cardinality invariant: `DriverCapabilitiesWriter`
 * explodes `flags` into one CHECK-constrained `driver_capabilities` row per
 * flag, so the table requires EXACTLY the canonical set — no more, no fewer.
 * An extra/typo'd key would otherwise hit the SQL CHECK mid-transaction (a
 * leaky SqliteError), and an omitted key would silently persist a <7-row
 * partial cache. We REJECT extras here (contrast: tool metadata STRIPS unknown
 * keys for forward-compat) because each flag maps to a fixed CHECK-constrained
 * row — the set is closed for this contract version. The canonical key-set is
 * sourced from the contract (`DRIVER_CAPABILITY_FLAGS`), kept in lockstep with
 * the frozen migration-0003 CHECK list.
 *
 * NOT a re-parse of already-normalized provider output (provider-driver.ts
 * §1(b) value-normalization stays the Phase-3 driver adapter's job) — only the
 * key-set cardinality this writer's schema choice created.
 *
 * Both halves are on an OWN-key basis (the cardinality check via `Object.keys`;
 * the per-flag loop via `Object.prototype.hasOwnProperty.call`). This is
 * load-bearing: a mixed basis (own-key cardinality + prototype-inclusive
 * `flags[flag]` access) would let a crafted 7-OWN-key input — one typo'd key,
 * with the missing canonical flag INHERITED as a boolean from the prototype —
 * pass both checks, then trip the SQL CHECK mid-transaction (a leaky
 * SqliteError) for exactly the input class this guard exists to reject. With
 * cardinality === 7 AND all 7 canonical flags present as OWN keys, pigeonhole
 * guarantees the own-key set is EXACTLY canonical — so the writer's
 * `Object.keys`-based write loop can never reach a non-canonical key.
 *
 * The param is `unknown` (not `Record<string, unknown>`) DELIBERATELY: the
 * static type is erased at runtime, so a malformed driver can ship `flags` as
 * null/array/primitive. Typing it `unknown` stops the type system from masking
 * that runtime risk and forces the non-null-object guard below, which keeps
 * `Object.keys(flags)` from raw-throwing a TypeError (`Object.keys(null)`) and
 * escaping this module's leak-safe doctrine.
 */
export function assertValidCapabilityFlags(flags: unknown): void {
  if (typeof flags !== "object" || flags === null || Array.isArray(flags)) {
    throw new ProviderOutputValidationError("Invalid driver capability flags.", {
      field: "flags",
      reason: "flags must be an object",
    });
  }
  const flagRecord = flags as Record<string, unknown>;
  const keys = Object.keys(flagRecord);
  if (keys.length !== DRIVER_CAPABILITY_FLAGS.length) {
    throw new ProviderOutputValidationError("Invalid driver capability flags.", {
      field: "flags",
      reason: `must declare exactly the ${DRIVER_CAPABILITY_FLAGS.length.toString()} canonical capability flags`,
    });
  }
  for (const flag of DRIVER_CAPABILITY_FLAGS) {
    if (
      !Object.prototype.hasOwnProperty.call(flagRecord, flag) ||
      typeof flagRecord[flag] !== "boolean"
    ) {
      throw new ProviderOutputValidationError("Invalid driver capability flags.", {
        field: "flags",
        reason: "each canonical capability flag must be present and boolean",
      });
    }
  }
}
