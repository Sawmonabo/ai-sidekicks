// TypeScript type surface for the canonical Shipment Manifest parser/validator/
// writer. `manifest.mjs` is plain ESM JavaScript (no JSDoc); this declaration is
// its authoritative TypeScript contract.
//
// The .mjs runtime is authoritative for BEHAVIOR; this file is authoritative for
// the SHAPE TypeScript consumers see. They must stay in lockstep — the drift
// test in `tools/docs-corpus/__tests__/plan-manifest-presence.test.ts` exercises
// `parseManifestBlock` against fixtures, so a divergence between this declaration
// and the .mjs runtime fails CI.
//
// Type-only: never imported at runtime, never executed. The runtime parser is
// shared by /plan-execution preflight Gate 3, the Phase E housekeeper, and the
// docs-corpus CI guard (tools/docs-corpus/lib/plan-manifest-presence.ts), which
// is the first TypeScript consumer.

/** A single shipped-PR record appended by the Phase E housekeeper. */
export interface ManifestEntry {
  phase: number;
  /** Single task id (default) or an array for legacy multi-task PRs. */
  task: string | string[];
  pr: number;
  /** Hex commit SHA, 7–40 chars. */
  sha: string;
  /** Merge date, `YYYY-MM-DD`. */
  merged_at: string;
  files: string[];
  verifies_invariant?: string[];
  spec_coverage?: string[];
  notes?: string;
}

/** `parseManifestBlock` failure — the manifest is absent or unparseable. */
export type ManifestParseFailure = {
  ok: false;
  reason: "no_section" | "no_yaml_fence" | "missing_schema_version" | "missing_shipped";
};

/** `parseManifestBlock` success — a well-formed manifest block. */
export type ManifestParseSuccess = {
  ok: true;
  version: number;
  shipped: ManifestEntry[];
};

export type ManifestParseResult = ManifestParseFailure | ManifestParseSuccess;

/** Highest manifest schema version this module reads and writes. */
export const MANIFEST_SCHEMA_VERSION: number;

/** Exact heading line that opens the manifest subsection. */
export const MANIFEST_SECTION_HEADING: string;

/** Parse a plan's Shipment Manifest block from its full markdown source. */
export function parseManifestBlock(planSource: string): ManifestParseResult;

/** Validate one entry against the schema (required keys, field types). */
export function validateEntry(entry: unknown): { ok: true } | { ok: false; errors: string[] };

/**
 * Append `entry` to the manifest, returning the updated plan source. Idempotent
 * on `entry.pr`; throws if the block is invalid or the on-disk schema version
 * exceeds {@link MANIFEST_SCHEMA_VERSION}.
 */
export function appendManifestEntry(planSource: string, entry: ManifestEntry): string;

/** Serialize one entry to its YAML lines (write-side helper). */
export function serializeEntry(entry: ManifestEntry): string[];
