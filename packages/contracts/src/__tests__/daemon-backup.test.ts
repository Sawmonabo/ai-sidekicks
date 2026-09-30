// A restore reads each backup's manifest straight from the folder, so the manifest must never
// carry the master key itself, only the id of the key it was sealed with.
import { describe, expect, it } from "vitest";

import { BackupManifestSchema } from "../daemon-backup.js";

const manifest = {
  backupId: "2026-09-29T0312",
  takenAt: "2026-09-29T03:12:00-04:00",
  appVersion: "0.1.0",
  serviceVersion: "0.1.0",
  totalBytes: 1_400_000_000,
  computerName: "Mac mini",
  masterKeyId: "0123456789abcdef0123456789abcdef",
};

describe("BackupManifestSchema", () => {
  it("accepts a manifest, and one naming the side of a Windows computer that wrote it", () => {
    expect(BackupManifestSchema.safeParse(manifest).success).toBe(true);
    expect(
      BackupManifestSchema.safeParse({ ...manifest, place: { distro: "Ubuntu" } }).success,
    ).toBe(true);
  });

  it("refuses the master key itself", () => {
    expect(BackupManifestSchema.safeParse({ ...manifest, masterKey: "a".repeat(32) }).success).toBe(
      false,
    );
  });
});
