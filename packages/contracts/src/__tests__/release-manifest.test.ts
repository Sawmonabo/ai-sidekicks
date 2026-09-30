// The command line's self-update and the desktop app's updater both parse the
// release manifest with this schema after verifying its signatures.
import { describe, expect, it } from "vitest";

import { ReleaseManifestSchema, ReleaseVersionSchema } from "../release-manifest.js";

const HEX_64 = "a".repeat(64);

const manifest = {
  version: 127,
  released_at: "2026-04-19T00:00:00Z",
  expires_at: "2026-05-19T00:00:00Z",
  previous_manifest_hash: `sha256:${HEX_64}`,
  next_signing_keys: ["ed25519:MCowBQYDK2VwAyEA"],
  artifacts: {
    "linux-x64": { url: "https://example.com/sidekicks-linux-x64.tar.gz", sha256: HEX_64 },
    "darwin-arm64": { url: "https://example.com/sidekicks-darwin-arm64.tar.gz", sha256: HEX_64 },
  },
};

describe("ReleaseManifestSchema", () => {
  it("accepts a published manifest", () => {
    expect(ReleaseManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it.each([
    ["a version that is not a positive whole number", { version: 1.5 }],
    ["an expiry more than 30 days after the release", { expires_at: "2026-05-19T00:00:01Z" }],
    ["an expiry before the release", { expires_at: "2026-04-18T00:00:00Z" }],
    ["a previous hash without its sha256 prefix", { previous_manifest_hash: HEX_64 }],
    ["a signing key without its ed25519 prefix", { next_signing_keys: ["MCowBQYDK2VwAyEA"] }],
    [
      "an artifact fetched over plain http",
      { artifacts: { "linux-x64": { url: "http://example.com/a", sha256: HEX_64 } } },
    ],
    [
      "an artifact hash that is not 64 hex digits",
      { artifacts: { "linux-x64": { url: "https://example.com/a", sha256: "abc" } } },
    ],
    ["an unknown member", { channel: "beta" }],
  ])("refuses %s", (_case, change) => {
    expect(ReleaseManifestSchema.safeParse({ ...manifest, ...change }).success).toBe(false);
  });

  it("refuses a manifest missing its expiry", () => {
    const { expires_at: _expiresAt, ...withoutExpiry } = manifest;
    expect(ReleaseManifestSchema.safeParse(withoutExpiry).success).toBe(false);
  });
});

describe("ReleaseVersionSchema", () => {
  it("accepts a release version with and without a suffix", () => {
    expect(ReleaseVersionSchema.safeParse("0.1.0").success).toBe(true);
    expect(ReleaseVersionSchema.safeParse("1.4.0-beta.2").success).toBe(true);
  });

  it("refuses a version that is not MAJOR.MINOR.PATCH", () => {
    expect(ReleaseVersionSchema.safeParse("1.4").success).toBe(false);
  });
});
