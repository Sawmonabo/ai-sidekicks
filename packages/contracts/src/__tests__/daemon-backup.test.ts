// A restore reads each backup's manifest straight from the folder, and a backup holds no key, so
// the manifest refuses one.
import { describe, expect, it } from "vitest";

import { BackupManifestSchema } from "../daemon-backup.js";

const manifest = {
  backupId: "2026-09-29T0312",
  takenAt: "2026-09-29T03:12:00-04:00",
  appVersion: "0.1.0",
  serviceVersion: "0.1.0",
  totalBytes: 1_400_000_000,
  computerName: "Mac mini",
};

describe("BackupManifestSchema", () => {
  it("accepts a manifest, and one naming the side of a Windows computer that wrote it", () => {
    expect(BackupManifestSchema.safeParse(manifest).success).toBe(true);
    expect(
      BackupManifestSchema.safeParse({ ...manifest, place: { distro: "Ubuntu" } }).success,
    ).toBe(true);
  });

  it("refuses a key", () => {
    expect(BackupManifestSchema.safeParse({ ...manifest, masterKey: "a".repeat(32) }).success).toBe(
      false,
    );
  });
});
