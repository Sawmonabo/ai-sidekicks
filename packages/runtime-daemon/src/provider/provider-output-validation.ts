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
// Spec coverage: Spec-005:47 (resume_handle is a provider-owned opaque handle,
// bounded at the write seam).
//
// Refs: Plan-005 §Phase 2 / T2.2 + T2.4, Spec-005 line 47.

import { wireFreeFormString } from "@ai-sidekicks/contracts";
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
// This is why the refinement is `semver.valid(v) === v` and not `!== null`.
const contractVersionSchema = wireFreeFormString(
  CONTRACT_VERSION_MAX_LEN,
  "contract_version",
).refine((value) => semver.valid(value) === value, {
  message: "contract_version must be a canonical semver string.",
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
      reason: "must be a canonical semver string within length bounds",
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
