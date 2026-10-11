// An app error the desktop hands the service lands as one line in the service log file, and the
// diagnostic-log expiry deletes that file whole once it is past the bound, keeping a younger file
// and the file this start writes, however long it has been quiet.

import { mkdtemp, readdir, readFile, rm, utimes } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";

import type { AppDiagnosticRecord } from "@ai-sidekicks/contracts/daemon/app-diagnostic";
import { afterEach, describe, expect, it } from "vitest";

import { MethodRegistryImpl } from "../../ipc/registry.js";
import { registerAppDiagnosticMethods } from "../app-diagnostic-methods.js";
import { DIAGNOSTIC_LOG_KEEP_MS, expireDiagnosticLogs } from "../diagnostic-log-expiry.js";
import { openServiceLog } from "../service-log.js";

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
  it("deletes an app error's log once past the bound and keeps a younger one and its own", async () => {
    dataFolder = await mkdtemp(path.join(os.tmpdir(), "sidekicks-diagnostic-logs-"));
    const earlierStart = openServiceLog({
      dataFolder,
      startedAt: new Date(NOW - 10 * DAY_MS),
      standardError: new PassThrough(),
    });
    const registry = new MethodRegistryImpl();
    registerAppDiagnosticMethods(registry, earlierStart.write);
    await registry.dispatch("daemon.appDiagnostic.record", RECORD, {});
    const loggedLines = (await readFile(earlierStart.filePath, "utf8")).split("\n");
    expect(loggedLines).toContain(`App diagnostic: ${JSON.stringify(RECORD)}`);

    const youngerStart = openServiceLog({
      dataFolder,
      startedAt: new Date(NOW - 2 * DAY_MS),
      standardError: new PassThrough(),
    });
    youngerStart.write("A younger start's line.");
    const thisStart = openServiceLog({
      dataFolder,
      startedAt: new Date(NOW),
      standardError: new PassThrough(),
    });
    await age(earlierStart.filePath, DIAGNOSTIC_LOG_KEEP_MS + DAY_MS);
    await age(youngerStart.filePath, DIAGNOSTIC_LOG_KEEP_MS - DAY_MS);
    await age(thisStart.filePath, DIAGNOSTIC_LOG_KEEP_MS + DAY_MS);
    const expiryLines: string[] = [];

    await expireDiagnosticLogs({
      serviceLogFile: thisStart.filePath,
      keepMs: DIAGNOSTIC_LOG_KEEP_MS,
      now: () => NOW,
      writeServiceLog: (line) => expiryLines.push(line),
    });

    expect((await readdir(path.dirname(thisStart.filePath))).sort()).toStrictEqual(
      [path.basename(youngerStart.filePath), path.basename(thisStart.filePath)].sort(),
    );
    expect(expiryLines).toStrictEqual([]);
  });
});

// Sets a file's last write `ageMs` before the test's clock.
async function age(filePath: string, ageMs: number): Promise<void> {
  const writtenAt = new Date(NOW - ageMs);
  await utimes(filePath, writtenAt, writtenAt);
}
