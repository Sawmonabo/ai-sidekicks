// The diagnostic-log expiry: every file in the folder the service log is kept in is deleted whole
// once it was last written longer ago than the bound, so a log is kept as long as its newest line
// is young enough, and the file this start writes is never deleted, however long it has been
// quiet. A file that cannot be read or deleted is told in the service log and the pass goes on.

import { lstat, readdir, rm } from "node:fs/promises";
import * as path from "node:path";

import { isMissingFileError } from "../file/missing-error.js";
import { describeRejection } from "../rejection.js";
import type { ServiceLogWriter } from "./service-log.js";

/**
 * How long a diagnostic log is kept: seven days, the default of `Keep diagnostic logs for`, which
 * the service holds no setting for yet.
 */
export const DIAGNOSTIC_LOG_KEEP_MS: number = 7 * 24 * 60 * 60 * 1000;

/** How often the expiry runs: hourly, so no log outlives its bound by more than an hour. */
export const DIAGNOSTIC_LOG_EXPIRY_INTERVAL_MS: number = 60 * 60 * 1000;

/** What one pass of the expiry reads and deletes. */
export interface DiagnosticLogExpiry {
  /** The file this start's service log writes, whose folder holds every diagnostic log. */
  readonly serviceLogFile: string;
  /** How long a file is kept after it was last written, in milliseconds. */
  readonly keepMs: number;
  /** The wall clock, in milliseconds since the epoch. */
  readonly now: () => number;
  readonly writeServiceLog: ServiceLogWriter;
}

/** Deletes every diagnostic log last written before the bound, but this start's own. */
export async function expireDiagnosticLogs(expiry: DiagnosticLogExpiry): Promise<void> {
  const folder = path.dirname(expiry.serviceLogFile);
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
    if (filePath === expiry.serviceLogFile) {
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
