// An app error the desktop hands the service lands as one line in the service log file, and the
// diagnostic-log expiry deletes that file whole once it is past the bound, keeping a younger file,
// the live file however long it has been quiet, and every file in the folder that is no service
// log; a daemon that runs for weeks begins a new file each day, so the days before the bound go.

import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";

import type { AppDiagnosticRecord } from "@ai-sidekicks/contracts/daemon/app-diagnostic";
import { DEFAULT_KEEP_DIAGNOSTIC_LOGS_MS } from "@ai-sidekicks/contracts/daemon/retention";
import { afterEach, describe, expect, it } from "vitest";

import { registerAppDiagnosticMethods } from "../../daemon/app-diagnostic-methods.js";
import { openServiceLog, SERVICE_LOG_FILE_MAX_AGE_MS } from "../../daemon/service-log.js";
import { MethodRegistryImpl } from "../../ipc/registry.js";
import { expireDiagnosticLogs } from "../diagnostic-buckets/expiry.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-11T12:00:00.000Z");

const RECORD: AppDiagnosticRecord = {
  kind: "uncaught-error",
  at: "2026-10-01T09:30:00.000Z",
  role: "console-window",
  name: "TypeError",
  message: "Cannot read properties of undefined (reading '…')",
  stack: "    at drawRow (app://renderer/assets/index.js:12:345)",
  source: { address: "app://renderer/assets/index.js", line: 12, column: 345 },
};

let dataFolder: string | undefined;

afterEach(async () => {
  if (dataFolder !== undefined) {
    await rm(dataFolder, { recursive: true, force: true });
    dataFolder = undefined;
  }
});

describe("the diagnostic-log expiry", () => {
  it("deletes an app error's log once past the bound and keeps the rest", async () => {
    dataFolder = await mkdtemp(path.join(os.tmpdir(), "sidekicks-diagnostic-logs-"));
    const earlierStart = logStartedAt(dataFolder, NOW - 10 * DAY_MS);
    const registry = new MethodRegistryImpl();
    registerAppDiagnosticMethods(registry, earlierStart.write);
    await registry.dispatch("daemon.appDiagnostic.record", RECORD, {});
    const loggedLines = (await readFile(earlierStart.liveFile(), "utf8")).split("\n");
    expect(loggedLines).toContain(`App diagnostic: ${JSON.stringify(RECORD)}`);

    const youngerStart = logStartedAt(dataFolder, NOW - 2 * DAY_MS);
    youngerStart.write("A younger start's line.");
    const thisStart = logStartedAt(dataFolder, NOW);
    const logsFolder = path.dirname(thisStart.liveFile());
    const otherFile = path.join(logsFolder, "notes.txt");
    await writeFile(otherFile, "Not a service log.\n");
    await age(earlierStart.liveFile(), DEFAULT_KEEP_DIAGNOSTIC_LOGS_MS + DAY_MS);
    await age(youngerStart.liveFile(), DEFAULT_KEEP_DIAGNOSTIC_LOGS_MS - DAY_MS);
    await age(thisStart.liveFile(), DEFAULT_KEEP_DIAGNOSTIC_LOGS_MS + DAY_MS);
    await age(otherFile, DEFAULT_KEEP_DIAGNOSTIC_LOGS_MS + DAY_MS);
    const expiryLines: string[] = [];

    await expireDiagnosticLogs({
      serviceLog: thisStart,
      keepMs: DEFAULT_KEEP_DIAGNOSTIC_LOGS_MS,
      now: () => NOW,
      writeServiceLog: (line) => expiryLines.push(line),
    });

    expect((await readdir(logsFolder)).sort()).toStrictEqual(
      [
        path.basename(youngerStart.liveFile()),
        path.basename(thisStart.liveFile()),
        "notes.txt",
      ].sort(),
    );
    expect(expiryLines).toStrictEqual([]);
  });

  it("begins a new file each day a long-running daemon writes, so its old days go", async () => {
    dataFolder = await mkdtemp(path.join(os.tmpdir(), "sidekicks-diagnostic-logs-"));
    let now = NOW;
    const serviceLog = openServiceLog({
      dataFolder,
      now: () => new Date(now),
      standardError: new PassThrough(),
    });
    const expire = (): Promise<void> =>
      expireDiagnosticLogs({
        serviceLog,
        keepMs: DEFAULT_KEEP_DIAGNOSTIC_LOGS_MS,
        now: () => now,
        writeServiceLog: serviceLog.write,
      });
    serviceLog.write("The first day's line.");
    const firstDay = serviceLog.liveFile();

    // Short of a day, the file goes on; a day after it was begun, the next one is.
    now += SERVICE_LOG_FILE_MAX_AGE_MS - 1;
    await expire();
    expect(serviceLog.liveFile()).toBe(firstDay);
    now += 1;
    await expire();
    expect(serviceLog.liveFile()).not.toBe(firstDay);
    serviceLog.write("The second day's line.");
    expect(await readFile(serviceLog.liveFile(), "utf8")).toBe("The second day's line.\n");

    // Once the first day's file was last written longer ago than the bound, it goes.
    await age(firstDay, 0);
    now += DEFAULT_KEEP_DIAGNOSTIC_LOGS_MS + 1;
    await expire();
    expect(await readdir(path.dirname(firstDay))).not.toContain(path.basename(firstDay));
  });
});

// A service log begun at `startedAt`, as a daemon started then opens it.
function logStartedAt(folder: string, startedAt: number): ReturnType<typeof openServiceLog> {
  return openServiceLog({
    dataFolder: folder,
    now: () => new Date(startedAt),
    standardError: new PassThrough(),
  });
}

// Sets a file's last write `ageMs` before the test's clock.
async function age(filePath: string, ageMs: number): Promise<void> {
  const writtenAt = new Date(NOW - ageMs);
  await utimes(filePath, writtenAt, writtenAt);
}
