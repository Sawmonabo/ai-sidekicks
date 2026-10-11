// The diagnostic-log expiry: each pass first has the service log begin its next file once the live
// one is a day old, then deletes whole every service log file last written longer ago than the
// bound, so a log is kept as long as its newest line is young enough and no line outlives the bound
// by more than a day while the daemon runs for weeks. The live file is never deleted, and a file in
// the folder that is no service log file is never touched. A file that cannot be read or deleted is
// told in the service log and the pass goes on.

import { lstat, readdir, rm } from "node:fs/promises";
import * as path from "node:path";

import {
  isServiceLogFileName,
  type ServiceLogFiles,
  type ServiceLogWriter,
} from "../../daemon/service-log.js";
import { isMissingFileError } from "../../file/missing-error.js";
import { describeRejection } from "../../rejection.js";

/** How often the expiry runs: hourly, so no log outlives its bound by more than an hour. */
export const DIAGNOSTIC_LOG_EXPIRY_INTERVAL_MS: number = 60 * 60 * 1000;

/** What one pass of the expiry reads and deletes. */
export interface DiagnosticLogExpiry {
  /** The service log's files: the live one, whose folder holds the rest, and its turn by age. */
  readonly serviceLog: ServiceLogFiles;
  /** How long a file is kept after it was last written, in milliseconds. */
  readonly keepMs: number;
  /** The wall clock, in milliseconds since the epoch. */
  readonly now: () => number;
  readonly writeServiceLog: ServiceLogWriter;
}

/** Turns the live service log by age, then deletes every other one last written before the bound. */
export async function expireDiagnosticLogs(expiry: DiagnosticLogExpiry): Promise<void> {
  expiry.serviceLog.rotateByAge();
  const liveFile = expiry.serviceLog.liveFile();
  const folder = path.dirname(liveFile);
  let names: string[];
  try {
    names = await readdir(folder);
  } catch (failure) {
    if (isMissingFileError(failure)) {
      return;
    }
    expiry.writeServiceLog(
      `The diagnostic logs in ${folder} could not be listed: ${describeRejection(failure)}`,
    );
    return;
  }
  const cutoff = expiry.now() - expiry.keepMs;
  for (const name of names) {
    const filePath = path.join(folder, name);
    if (filePath === liveFile || !isServiceLogFileName(name)) {
      continue;
    }
    try {
      const stats = await lstat(filePath);
      if (stats.isFile() && stats.mtimeMs < cutoff) {
        await rm(filePath, { force: true });
      }
    } catch (failure) {
      if (!isMissingFileError(failure)) {
        expiry.writeServiceLog(
          `The diagnostic log ${filePath} could not be expired: ${describeRejection(failure)}`,
        );
      }
    }
  }
}
