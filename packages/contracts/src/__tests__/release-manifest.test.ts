// The command line's self-update and the desktop app's updater both parse the release manifest
// with this schema after verifying its signatures. It caps a manifest's validity at 30 days after
// its release, so a signed manifest cannot stay replayable for longer.
import { describe, expect, it } from "vitest";

import { ReleaseManifestSchema } from "../release-manifest.js";

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
    ["an expiry more than 30 days after the release", { expires_at: "2026-05-19T00:00:01Z" }],
    ["an expiry before the release", { expires_at: "2026-04-18T00:00:00Z" }],
  ])("refuses %s", (_case, change) => {
    expect(ReleaseManifestSchema.safeParse({ ...manifest, ...change }).success).toBe(false);
  });
});
