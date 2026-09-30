// Settings › Runtime and the command line send these verbs to the service; each
// request and result is parsed through the method's own descriptor.
import { describe, expect, it } from "vitest";

import { DAEMON_DATA_METHOD_DESCRIPTORS, DAEMON_PASSPHRASE_MAX_LEN } from "../daemon-data.js";

const JOB_ID = "550e8400-e29b-41d4-a716-446655440000";

const accepts = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown) =>
  expect(schema.safeParse(value).success).toBe(true);
const refuses = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown) =>
  expect(schema.safeParse(value).success).toBe(false);

describe("daemon.dataExport and its progress stream", () => {
  const exportMethod = DAEMON_DATA_METHOD_DESCRIPTORS["daemon.dataExport"];
  const progressMethod = DAEMON_DATA_METHOD_DESCRIPTORS["daemon.dataExportSubscribe"];

  it("starts a job into a folder and streams its progress", () => {
    accepts(exportMethod.requestSchema, { destination: "/Users/me/sidekicks-export-2026-09-29" });
    accepts(exportMethod.responseSchema, { jobId: JOB_ID });
    accepts(progressMethod.requestSchema, { jobId: JOB_ID });
    accepts(progressMethod.emissionSchema, {
      state: "running",
      sessionsExported: 312,
      sessionsTotal: 1204,
    });
    accepts(progressMethod.emissionSchema, {
      state: "completed",
      path: "/Users/me/sidekicks-export-2026-09-29",
      totalBytes: 1_200_000_000,
    });
    accepts(progressMethod.emissionSchema, { state: "failed", message: "The disk is full." });
  });

  it("refuses an export with no destination or an unknown member", () => {
    refuses(exportMethod.requestSchema, {});
    refuses(exportMethod.requestSchema, { destination: "/tmp/out", includeSettings: true });
  });

  it("refuses progress that counts past its total, or an unknown state", () => {
    refuses(progressMethod.emissionSchema, {
      state: "running",
      sessionsExported: 1205,
      sessionsTotal: 1204,
    });
    refuses(progressMethod.emissionSchema, { state: "paused" });
  });
});

describe("the key verbs", () => {
  const unlock = DAEMON_DATA_METHOD_DESCRIPTORS["daemon.unlock"];
  const keyRotate = DAEMON_DATA_METHOD_DESCRIPTORS["daemon.keyRotate"];
  const recoveryPassphraseSet = DAEMON_DATA_METHOD_DESCRIPTORS["daemon.recoveryPassphraseSet"];
  const dataErase = DAEMON_DATA_METHOD_DESCRIPTORS["daemon.dataErase"];

  it("accepts each verb's request", () => {
    accepts(unlock.requestSchema, { passphrase: "correct horse battery staple" });
    accepts(keyRotate.requestSchema, {});
    accepts(keyRotate.requestSchema, { passphrase: "machine", recoveryPassphrase: "recovery" });
    accepts(recoveryPassphraseSet.requestSchema, { passphrase: "recovery" });
    accepts(dataErase.requestSchema, {});
  });

  it("refuses a missing, blank or over-long passphrase", () => {
    refuses(unlock.requestSchema, {});
    refuses(unlock.requestSchema, { passphrase: "   " });
    refuses(recoveryPassphraseSet.requestSchema, {
      passphrase: "x".repeat(DAEMON_PASSPHRASE_MAX_LEN + 1),
    });
  });

  it("refuses an unknown member on a request that takes none", () => {
    refuses(dataErase.requestSchema, { keepBackups: true });
    refuses(keyRotate.requestSchema, { newKey: "x" });
  });
});

describe("daemon.backupKeySyncUpdate", () => {
  const keySync = DAEMON_DATA_METHOD_DESCRIPTORS["daemon.backupKeySyncUpdate"];

  it("turns the switch and answers with its state", () => {
    accepts(keySync.requestSchema, { enabled: true });
    accepts(keySync.responseSchema, { state: "on" });
    accepts(keySync.responseSchema, { state: "off" });
    accepts(keySync.responseSchema, {
      state: "refused",
      reason: "iCloud Keychain is off on this Mac.",
    });
  });

  it("refuses a refused state with no reason, or an unknown state", () => {
    refuses(keySync.responseSchema, { state: "refused" });
    refuses(keySync.responseSchema, { state: "pending" });
  });
});
