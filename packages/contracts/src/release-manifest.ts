// The release manifest: the signed JSON file a release publishes beside its
// artifacts, and the version string a release carries.
//
// Two readers parse the manifest with this one schema: the command line's
// `sidekicks self-update`, which updates the background service, and the desktop
// app's updater. Each verifies the manifest's detached Ed25519 signature and its
// Sigstore bundle before parsing it here, and then refuses a manifest whose
// `version` is not above the last one it saw, whose `expires_at` has passed, or
// whose `previous_manifest_hash` does not chain to the last one it saw. Those
// checks need the reader's own record of what it last saw, so they are the
// reader's; this file holds the shape they read.
//
// The member names are the published file's own, in snake case, because the
// file is read by tools outside this package as well.
import { z } from "zod";

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

/** How long a manifest may stay valid after its release, in milliseconds (30 days). */
export const RELEASE_MANIFEST_MAX_VALIDITY_MS: number = 30 * 24 * 60 * 60 * 1000;

/** The longest artifact name, artifact URL or signing key a manifest carries. */
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
  /** At most 30 days after `released_at`. */
  expires_at: string;
  /** `sha256:` and the lowercase hex hash of the previous manifest's bytes. */
  previous_manifest_hash: string;
  /** The Ed25519 keys that will sign later manifests, each `ed25519:` and the key. */
  next_signing_keys: string[];
  /** Each artifact keyed by its platform name, e.g. `linux-x64` or `darwin-arm64`. */
  artifacts: Record<string, ReleaseManifestArtifact>;
}

/** Parses a {@link ReleaseManifest}. */
export const ReleaseManifestSchema: z.ZodType<ReleaseManifest> = z
  .object({
    version: z.number().int().positive(),
    released_at: z.iso.datetime({ offset: true }),
    expires_at: z.iso.datetime({ offset: true }),
    previous_manifest_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/u, {
      message: "previous_manifest_hash is sha256: and 64 lowercase hex digits.",
    }),
    next_signing_keys: z.array(
      z
        .string()
        .max(RELEASE_MANIFEST_FIELD_MAX_LEN)
        .regex(/^ed25519:\S+$/u, { message: "A signing key is ed25519: and the key." }),
    ),
    artifacts: z.record(
      z.string().min(1).max(RELEASE_MANIFEST_FIELD_MAX_LEN),
      ReleaseManifestArtifactSchema,
    ),
  })
  .strict()
  .superRefine((manifest, context) => {
    const validityMs = Date.parse(manifest.expires_at) - Date.parse(manifest.released_at);
    if (validityMs <= 0 || validityMs > RELEASE_MANIFEST_MAX_VALIDITY_MS) {
      context.addIssue({
        code: "custom",
        path: ["expires_at"],
        message: "expires_at must fall after released_at and at most 30 days after it.",
      });
    }
  });
