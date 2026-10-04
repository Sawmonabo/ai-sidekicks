// The release manifest: the JSON file a release publishes beside its artifacts,
// and the version string a release carries.
//
// The command line's `sidekicks self-update`, which updates the background
// service, parses the manifest with this schema, checks each download against its
// SHA-256, and refuses a manifest whose `version` is not above the last one it
// saw. That check needs the reader's own record of what it last saw, so it is the
// reader's; this file holds the shape it reads.
//
// The member names are the published file's own, in snake case, because the
// file is read by tools outside this package as well.
import { z } from "zod";
import { isoDateTimeSchema } from "./internal/wire-scalars.js";

/** The longest release version string accepted, e.g. `0.1.0`. */
export const RELEASE_VERSION_MAX_LEN = 64;

/**
 * A release's version as a person reads it, e.g. `0.1.0` or `1.4.0-beta.2`:
 * `MAJOR.MINOR.PATCH` with an optional pre-release and build suffix.
 */
export const ReleaseVersionSchema: z.ZodType<string, string> = z
  .string()
  .max(RELEASE_VERSION_MAX_LEN)
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u, {
    message: "A release version is MAJOR.MINOR.PATCH with an optional suffix.",
  });

/** The longest artifact name or artifact URL a manifest carries. */
export const RELEASE_MANIFEST_FIELD_MAX_LEN = 2048;

const SHA256_HEX = /^[0-9a-f]{64}$/u;

/** One published artifact: where to fetch it and the SHA-256 of its bytes, in lowercase hex. */
export interface ReleaseManifestArtifact {
  url: string;
  sha256: string;
}

/** Parses a {@link ReleaseManifestArtifact}; the URL must be `https`. */
export const ReleaseManifestArtifactSchema: z.ZodType<ReleaseManifestArtifact> = z
  .object({
    url: z.url({ protocol: /^https$/u }).max(RELEASE_MANIFEST_FIELD_MAX_LEN),
    sha256: z.string().regex(SHA256_HEX, { message: "sha256 is 64 lowercase hex digits." }),
  })
  .strict();

/** A release manifest as published. */
export interface ReleaseManifest {
  /** A whole number that rises with every release, never reused. */
  version: number;
  released_at: string;
  /** Each artifact keyed by its platform name, e.g. `linux-x64` or `darwin-arm64`. */
  artifacts: Record<string, ReleaseManifestArtifact>;
}

/**
 * Parses a {@link ReleaseManifest}.
 *
 * @consumedBy the command line's `sidekicks self-update`, which checks each download against the
 * manifest
 */
export const ReleaseManifestSchema: z.ZodType<ReleaseManifest> = z
  .object({
    version: z.number().int().positive(),
    released_at: isoDateTimeSchema,
    artifacts: z.record(
      z.string().min(1).max(RELEASE_MANIFEST_FIELD_MAX_LEN),
      ReleaseManifestArtifactSchema,
    ),
  })
  .strict();
