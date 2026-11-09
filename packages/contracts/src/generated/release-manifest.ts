// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The release manifest: the JSON file a release publishes beside its artifacts, and the version a release carries.

import type { WireInstant } from "./internal/wire-scalars.js";

/** The longest release version accepted. */
export const RELEASE_VERSION_MAX_LEN = 64 as const;

/** The longest artifact name or artifact address a manifest carries. */
export const RELEASE_MANIFEST_FIELD_MAX_LEN = 2048 as const;

/**
 * A release's version as a person reads it, `0.1.0` or `1.4.0-beta.2`: `MAJOR.MINOR.PATCH`
 * with an optional pre-release and build suffix.
 */
export type ReleaseVersion = string;
/**
 * A SHA-256 digest in lowercase hex.
 */
export type Sha256Hex = string;

/**
 * One published artifact: where to fetch it, over `https`, and the SHA-256 of its bytes.
 */
export interface ReleaseManifestArtifact {
  /**
   * Where to fetch it.
   */
  url: string;
  /**
   * The SHA-256 of its bytes.
   */
  sha256: Sha256Hex;
}
/**
 * A release manifest as published.
 */
export interface ReleaseManifest {
  /**
   * A whole number that rises with every release, never reused.
   */
  version: number;
  /**
   * When the release was published.
   */
  released_at: WireInstant;
  /**
   * Each artifact keyed by its platform name, `linux-x64` or `darwin-arm64`.
   */
  artifacts: {
    [k: string]: ReleaseManifestArtifact | undefined;
  };
}
