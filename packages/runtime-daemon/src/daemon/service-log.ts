// The service log: every line goes to the daemon's standard error and to its own file,
// `logs/service-<start time>.log` in the data folder, opened at start, so the log is kept whoever
// started the daemon and whatever they did with its streams. Lines are written synchronously, so
// the last line before an exit is never lost. A file that cannot be opened or written leaves
// standard error carrying the log, and a standard error whose reader has gone leaves the file
// carrying it; either says why on the other once and never stops the daemon. Deleting old files
// belongs to the diagnostic-log expiry.

import { chmodSync, closeSync, fchmodSync, mkdirSync, openSync, writeSync } from "node:fs";
import * as path from "node:path";
import type { Writable } from "node:stream";

// The folder in the data folder that holds the service log files.
const SERVICE_LOG_FOLDER_NAME = "logs";

/** Writes one line to the service log. */
export type ServiceLogWriter = (line: string) => void;

/**
 * Opens this start's service log file in `dataFolder` and answers the writer every service-log
 * line goes through. Never throws: a file that cannot be opened is reported on `standardError`,
 * and a failed `standardError` stream, a closed pipe among them, is reported in the file.
 */
export function openServiceLog(options: {
  readonly dataFolder: string;
  readonly startedAt: Date;
  /** The process's standard error; the log takes over its `error` event. */
  readonly standardError: Writable;
}): ServiceLogWriter {
  const { standardError } = options;
  const folder = path.join(options.dataFolder, SERVICE_LOG_FOLDER_NAME);
  const filePath = path.join(folder, `service-${fileSafeTime(options.startedAt)}.log`);
  let fileDescriptor: number | undefined;
  let isStandardErrorOpen = true;

  const writeStandardError = (text: string): void => {
    if (isStandardErrorOpen) {
      standardError.write(text);
    }
  };
  const writeFile = (text: string): void => {
    if (fileDescriptor === undefined) {
      return;
    }
    try {
      writeSync(fileDescriptor, text);
    } catch (failure) {
      fileDescriptor = undefined;
      writeStandardError(
        `The service log file ${filePath} could not be written, so the service log goes to ` +
          `standard error alone from here: ${describeFailure(failure)}\n`,
      );
    }
  };

  // A pipe whose reader has gone fails the write after it with EPIPE, an `error` event that would
  // otherwise end the daemon.
  standardError.on("error", (failure) => {
    if (!isStandardErrorOpen) {
      return;
    }
    isStandardErrorOpen = false;
    writeFile(
      `Standard error failed, so the service log goes to its file alone from here: ` +
        `${describeFailure(failure)}\n`,
    );
  });

  try {
    // Readable by the person alone, as the data folder is. An existing folder or file, such as a
    // same-second restart's, keeps its own mode, so the mode is set again.
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    chmodSync(folder, 0o700);
    const opened = openSync(filePath, "a", 0o600);
    try {
      fchmodSync(opened, 0o600);
    } catch (failure) {
      closeSync(opened);
      throw failure;
    }
    fileDescriptor = opened;
  } catch (failure) {
    writeStandardError(
      `The service log file ${filePath} could not be opened, so the service log goes to ` +
        `standard error alone: ${describeFailure(failure)}\n`,
    );
  }
  return (line) => {
    const text = `${line}\n`;
    writeStandardError(text);
    writeFile(text);
  };
}

// `2026-10-05T08:12:03.456Z` becomes `2026-10-05T08-12-03Z`: no colon, which Windows refuses in
// a file name.
function fileSafeTime(time: Date): string {
  return `${time.toISOString().slice(0, 19).replaceAll(":", "-")}Z`;
}

function describeFailure(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}
