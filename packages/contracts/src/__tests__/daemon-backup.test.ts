// Settings › Runtime reads the backups through `daemon.backupRead`, and a restore
// reads each backup's manifest from the folder with the service stopped.
import { describe, expect, it } from "vitest";

import { BackupManifestSchema, DAEMON_BACKUP_METHOD_DESCRIPTORS } from "../daemon-backup.js";

const TAKEN_AT = "2026-09-29T03:12:00-04:00";

const manifest = {
  backupId: "2026-09-29T0312",
  takenAt: TAKEN_AT,
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

  it.each([
    ["a master key id that is not 32 lowercase hex digits", { masterKeyId: "0123" }],
    ["an app version that is not a release version", { appVersion: "latest" }],
    ["a side that is neither Windows nor a distribution", { place: "linux" }],
    ["the master key itself", { masterKey: "a".repeat(32) }],
  ])("refuses %s", (_case, change) => {
    expect(BackupManifestSchema.safeParse({ ...manifest, ...change }).success).toBe(false);
  });
});

describe("daemon.backupRead", () => {
  const backupRead = DAEMON_BACKUP_METHOD_DESCRIPTORS["daemon.backupRead"];
  const standing = {
    folder: "/Users/me/.ai-sidekicks/backups",
    folderOnServiceDisk: true,
    totalBytes: 1_400_000_000,
    lastRun: { outcome: "completed", finishedAt: TAKEN_AT },
    backups: [
      {
        backupId: "2026-09-29T0312",
        takenAt: TAKEN_AT,
        totalBytes: 1_400_000_000,
        appVersion: "0.1.0",
        computerName: "Mac mini",
        restoreAccess: "ready",
      },
    ],
    recoveryPassphrase: "notSet",
    keySync: { state: "off" },
  };

  it("reads where the backups stand, before the first run and after a failed one", () => {
    expect(backupRead.requestSchema.safeParse({}).success).toBe(true);
    expect(backupRead.responseSchema.safeParse(standing).success).toBe(true);
    expect(
      backupRead.responseSchema.safeParse({ ...standing, lastRun: null, backups: [] }).success,
    ).toBe(true);
    expect(
      backupRead.responseSchema.safeParse({
        ...standing,
        lastRun: { outcome: "failed", finishedAt: TAKEN_AT, message: "The folder is gone." },
      }).success,
    ).toBe(true);
  });

  it("refuses a failed run with no cause, or a backup with an unknown restore state", () => {
    expect(
      backupRead.responseSchema.safeParse({
        ...standing,
        lastRun: { outcome: "failed", finishedAt: TAKEN_AT },
      }).success,
    ).toBe(false);
    expect(
      backupRead.responseSchema.safeParse({
        ...standing,
        backups: [{ ...standing.backups[0], restoreAccess: "maybe" }],
      }).success,
    ).toBe(false);
  });
});
