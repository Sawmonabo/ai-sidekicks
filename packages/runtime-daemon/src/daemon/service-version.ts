// The service's version, its package's. The manifest is read from this module's own location,
// which the build keeps at its source path two folders below the package, so the read finds the
// same file from the source and from the build.

import { readFileSync } from "node:fs";

/** The service's version from its package's manifest; throws when the manifest names none. */
export function readServiceVersion(): string {
  const manifest: unknown = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  );
  if (
    typeof manifest === "object" &&
    manifest !== null &&
    "version" in manifest &&
    typeof manifest.version === "string"
  ) {
    return manifest.version;
  }
  throw new Error("The daemon's package.json names no version");
}
