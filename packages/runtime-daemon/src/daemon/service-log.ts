// The service log: every line goes to the daemon's standard error and to its own file in
// `logs/` in the data folder, `service-<time it was begun>.log`, the first opened at start, so the
// log is kept whoever started the daemon and whatever they did with its streams. A file is written
// for a day at most and up to 16 MiB, and the next one is begun then, so a daemon that runs for
// weeks leaves day-sized files the diagnostic-log expiry can delete whole past `Keep diagnostic
// logs for`, and no file grows without bound. Lines are written synchronously, so the last line
// before an exit is never lost. A file that cannot be opened or written leaves standard error
// carrying the log, and a standard error whose reader has gone leaves the file carrying it; either
// says why on the other once and never stops the daemon. Deleting old files belongs to the
// diagnostic-log expiry.

import {
  chmodSync,
  closeSync,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
  writeSync,
} from "node:fs";
import * as path from "node:path";
import type { Writable } from "node:stream";

import { describeRejection } from "../rejection.js";

// The folder in the data folder that holds the service log files.
const SERVICE_LOG_FOLDER_NAME = "logs";

/** The longest one service log file is written before the next is begun: a day. */
export const SERVICE_LOG_FILE_MAX_AGE_MS: number = 24 * 60 * 60 * 1000;

/**
 * The most bytes one service log file holds before the next is begun: 16 MiB, so each file stays
 * small enough to open and to delete whole; at ordinary rates the day bound turns a file first.
 */
export const SERVICE_LOG_FILE_BYTE_CEILING: number = 16 * 1024 * 1024;

// `service-2026-10-05T08-12-03Z.log`, as `serviceLogFileNameAt` names one.
const SERVICE_LOG_FILE_NAME = /^service-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.log$/;

/** Writes one line to the service log. */
export type ServiceLogWriter = (line: string) => void;

/** The service log's files, as the diagnostic-log expiry reads and turns them. */
export interface ServiceLogFiles {
  /** The file being written now, which the expiry never deletes. */
  liveFile(): string;
  /** Begins the next file once the live one holds a line and was begun a day or more ago. */
  rotateByAge(): void;
}

/** The service log: the writer every line goes through, and its files. */
export interface ServiceLog extends ServiceLogFiles {
  readonly write: ServiceLogWriter;
}

/** Whether `fileName` names a service log file, the only files in `logs/` the expiry deletes. */
export function isServiceLogFileName(fileName: string): boolean {
  return SERVICE_LOG_FILE_NAME.test(fileName);
}

/**
 * Opens the service log in `dataFolder`, its first file named for `now()`. Never throws: a file
 * that cannot be opened is reported on `standardError`, and a failed `standardError` stream, a
 * closed pipe among them, is reported in the file.
 */
export function openServiceLog(options: {
  readonly dataFolder: string;
  /** The wall clock each file is named and aged by. */
  readonly now: () => Date;
  /** The process's standard error; the log takes over its `error` event. */
  readonly standardError: Writable;
}): ServiceLog {
  const { standardError, now } = options;
  const folder = path.join(options.dataFolder, SERVICE_LOG_FOLDER_NAME);
  let filePath = "";
  let fileDescriptor: number | undefined;
  let fileBegunAt = 0;
  let fileByteCount = 0;
  let isStandardErrorOpen = true;

  const writeStandardError = (text: string): void => {
    if (isStandardErrorOpen) {
      standardError.write(text);
    }
  };
  const openFile = (): void => {
    const begunAt = now();
    filePath = path.join(folder, serviceLogFileNameAt(begunAt));
    fileBegunAt = begunAt.getTime();
    try {
      // Readable by the person alone, as the data folder is. An existing folder or file keeps its
      // own mode, so the mode is set again.
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      chmodSync(folder, 0o700);
      const opened = openSync(filePath, "a", 0o600);
      try {
        fchmodSync(opened, 0o600);
        fileByteCount = fstatSync(opened).size;
      } catch (failure) {
        closeSync(opened);
        throw failure;
      }
      fileDescriptor = opened;
    } catch (failure) {
      writeStandardError(
        `The service log file ${filePath} could not be opened, so the service log goes to ` +
          `standard error alone from here: ${describeRejection(failure)}\n`,
      );
    }
  };
  // Closes the live file and begins the next; a log already on standard error alone stays so.
  const rotate = (): void => {
    if (fileDescriptor === undefined) {
      return;
    }
    const closing = fileDescriptor;
    fileDescriptor = undefined;
    try {
      closeSync(closing);
    } catch (failure) {
      writeStandardError(
        `The service log file ${filePath} could not be closed: ${describeRejection(failure)}\n`,
      );
    }
    openFile();
  };
  const writeFile = (text: string): void => {
    const byteCount = Buffer.byteLength(text);
    if (fileByteCount > 0 && fileByteCount + byteCount > SERVICE_LOG_FILE_BYTE_CEILING) {
      rotate();
    }
    if (fileDescriptor === undefined) {
      return;
    }
    try {
      writeSync(fileDescriptor, text);
      fileByteCount += byteCount;
    } catch (failure) {
      fileDescriptor = undefined;
      writeStandardError(
        `The service log file ${filePath} could not be written, so the service log goes to ` +
          `standard error alone from here: ${describeRejection(failure)}\n`,
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
        `${describeRejection(failure)}\n`,
    );
  });

  openFile();
  return {
    write: (line) => {
      const text = `${line}\n`;
      writeStandardError(text);
      writeFile(text);
    },
    liveFile: () => filePath,
    rotateByAge: () => {
      if (fileByteCount > 0 && now().getTime() - fileBegunAt >= SERVICE_LOG_FILE_MAX_AGE_MS) {
        rotate();
      }
    },
  };
}

// A file named for the second it was begun. One begun in the same second as the one before it is
// that file, opened to append again.
function serviceLogFileNameAt(time: Date): string {
  return `service-${formatFileSafeTime(time)}.log`;
}

// `2026-10-05T08:12:03.456Z` becomes `2026-10-05T08-12-03Z`: no colon, which Windows refuses in
// a file name.
function formatFileSafeTime(time: Date): string {
  return `${time.toISOString().slice(0, 19).replaceAll(":", "-")}Z`;
}
