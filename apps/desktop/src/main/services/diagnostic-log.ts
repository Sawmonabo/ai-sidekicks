// Main's own JSONL log: async append, size rotation, level filter. Main's failures have no
// other reporter, since a window that never opened has no renderer to capture from. It
// forwards nowhere; it writes a file and stops. It is built in-house because it is one append
// path, one rotation rule and one level filter, and a library such as `electron-log` would add
// a transport registry and a renderer hook.
//
// The file operations are injected, so a test drives real rotation in a temporary directory
// and a failure case drives a sink that throws.
//
// The size ceiling belongs to the file, not the process: main appends to the same path every
// launch, so the byte count is seeded from the file on the first queued write (lazily, so a
// log that never writes never touches the disk). The seeded count is still per process: two
// processes appending would rotate the file out from under each other. The single-instance
// lock in `index.ts` prevents that except for a relaunch overlapping a first instance that is
// still failing to start.
//
// A write never throws at its caller and never fails silently: it stops accepting and records
// why (`lastWriteFailure`), which the quit and exit paths read. The file and its folder are
// readable only by the person, as main's other files are: a line can quote a path.

import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import { describeFailure } from "./failure-message.js";
import { isMissingPath } from "./missing-path.js";
import { OWNER_ONLY_FILE_MODE, OWNER_ONLY_FOLDER_MODE } from "./owner-only-file.js";

/** How bad one entry is. Closed, and ordered most severe first. */
export const DIAGNOSTIC_LOG_LEVELS = ["error", "warning", "notice"] as const;

/** One level, derived so the set is declared exactly once. */
export type DiagnosticLogLevel = (typeof DIAGNOSTIC_LOG_LEVELS)[number];

/** What a caller writes; the log stamps it with the time it was written. */
export interface MainDiagnosticEntry {
  readonly level: DiagnosticLogLevel;
  /** The main-process module that wrote it. */
  readonly source: string;
  readonly message: string;
}

/** One line of the log: an entry and when it was written, ISO-8601. */
export interface MainDiagnosticLine extends MainDiagnosticEntry {
  readonly at: string;
}

/** The file operations the log performs. Injected, so a test owns all four. */
export interface DiagnosticLogFileSink {
  /** Bytes the file already holds, or `0` when there is no such file (the first launch). */
  byteCountOf(filePath: string): Promise<number>;
  /** Append, creating the containing directory if it is not there yet. */
  appendUtf8(filePath: string, text: string): Promise<void>;
  /** Replace `toPath` with `fromPath`. Rotation, and the only rename this log does. */
  replace(fromPath: string, toPath: string): Promise<void>;
  remove(filePath: string): Promise<void>;
}

/** How the log is built. */
export interface MainDiagnosticLogOptions {
  readonly filePath: string;
  readonly sink: DiagnosticLogFileSink;
  /** Entries below this level are filtered out before any byte is written. */
  readonly minimumLevel: DiagnosticLogLevel;
  /** Bytes the live file may reach before it rotates. */
  readonly fileByteCeiling: number;
  /** The clock each entry is stamped from as it is written. */
  readonly now: () => Date;
}

/** Where the rotated file goes. One generation: the previous file, and no more. */
export function rotatedPathFor(filePath: string): string {
  return `${filePath}.1`;
}

function levelRank(level: DiagnosticLogLevel): number {
  return DIAGNOSTIC_LOG_LEVELS.indexOf(level);
}

/**
 * One entry as one JSON line, newline-terminated. Field order is fixed, so equal entries encode
 * to equal bytes and a test can compare a written file against an expected one.
 */
export function toLogLine(line: MainDiagnosticLine): string {
  return `${JSON.stringify({
    at: line.at,
    level: line.level,
    source: line.source,
    message: line.message,
  })}\n`;
}

/**
 * The main process's log. Writes are serialized through one promise chain: overlapping
 * appends to one file can interleave at the byte level on at least one supported platform,
 * and a half line breaks every reader. The chain also keeps the byte count exact.
 */
export class MainDiagnosticLog {
  readonly #filePath: string;
  readonly #sink: DiagnosticLogFileSink;
  readonly #minimumRank: number;
  readonly #fileByteCeiling: number;
  readonly #now: () => Date;
  #writeChain: Promise<void> = Promise.resolve();
  /** `null` until the first queued write reads the file's own size. */
  #liveFileByteCount: number | null = null;
  #writtenEntryCount = 0;
  #rotationCount = 0;
  #writeFailureCount = 0;
  #lastWriteFailure: string | null = null;
  #accepting = true;

  public constructor(options: MainDiagnosticLogOptions) {
    this.#filePath = options.filePath;
    this.#sink = options.sink;
    this.#minimumRank = levelRank(options.minimumLevel);
    this.#fileByteCeiling = options.fileByteCeiling;
    this.#now = options.now;
  }

  /**
   * Write one entry, stamped now, if its level passes the filter. Returns nothing so a caller
   * never waits on the disk; `drain()` is how a test and the quit and exit paths wait.
   */
  public write(entry: MainDiagnosticEntry): void {
    if (levelRank(entry.level) > this.#minimumRank || !this.#accepting) {
      return;
    }
    const line = toLogLine({ at: this.#now().toISOString(), ...entry });
    const lineByteCount = Buffer.byteLength(line, "utf8");
    this.#writeChain = this.#writeChain.then(async () => {
      if (!this.#accepting) {
        return;
      }
      try {
        let liveByteCount = await this.#resolveLiveFileByteCount();
        if (liveByteCount + lineByteCount > this.#fileByteCeiling) {
          await this.#rotate();
          liveByteCount = await this.#resolveLiveFileByteCount();
        }
        await this.#sink.appendUtf8(this.#filePath, line);
        this.#liveFileByteCount = liveByteCount + lineByteCount;
        this.#writtenEntryCount += 1;
      } catch (writeFailure) {
        // Stop accepting rather than retry: a full disk or a revoked path would fail once
        // per line and spend the quit budget.
        this.#accepting = false;
        this.#writeFailureCount += 1;
        this.#lastWriteFailure = describeFailure(writeFailure);
      }
    });
  }

  /**
   * How many bytes the live file holds, read once and then carried. It runs inside the write
   * chain, so two writes issued in the same tick cannot both seed it.
   */
  async #resolveLiveFileByteCount(): Promise<number> {
    const carried = this.#liveFileByteCount;
    if (carried !== null) {
      return carried;
    }
    const onDisk = await this.#sink.byteCountOf(this.#filePath);
    this.#liveFileByteCount = onDisk;
    return onDisk;
  }

  /**
   * Rotate: the previous rotation is removed and the live file becomes the rotation. The
   * remove comes first and tolerates a missing file, because `replace` onto an existing path
   * is not atomic on every supported platform. The rename invalidates the carried byte count,
   * so the rotation resets it here rather than leaving that to the caller.
   */
  async #rotate(): Promise<void> {
    const rotatedPath = rotatedPathFor(this.#filePath);
    await this.#sink.remove(rotatedPath);
    await this.#sink.replace(this.#filePath, rotatedPath);
    this.#rotationCount += 1;
    this.#liveFileByteCount = 0;
  }

  /** Settle every write issued so far. The quit and exit paths and every test await this. */
  public async drain(): Promise<void> {
    await this.#writeChain;
  }

  /** Entries written to the file. */
  public get writtenEntryCount(): number {
    return this.#writtenEntryCount;
  }

  /** How many times the file has rotated. */
  public get rotationCount(): number {
    return this.#rotationCount;
  }

  /** How many writes failed. Non-zero means the log stopped accepting. */
  public get writeFailureCount(): number {
    return this.#writeFailureCount;
  }

  /** Why the log stopped accepting, or `null` while it still is. */
  public get lastWriteFailure(): string | null {
    return this.#lastWriteFailure;
  }

  /** Whether the log is still taking entries. */
  public get isAccepting(): boolean {
    return this.#accepting;
  }
}

/**
 * The sink over the real file system. A class because it carries one piece of state: the
 * directory is created before the first append, not before every one.
 */
class FileSystemDiagnosticLogSink implements DiagnosticLogFileSink {
  /** The directory this sink has already created, or `null` before the first append. */
  #ensuredDirectory: string | null = null;

  public async byteCountOf(filePath: string): Promise<number> {
    try {
      return (await stat(filePath)).size;
    } catch (statFailure) {
      if (isMissingPath(statFailure)) {
        return 0;
      }
      throw statFailure;
    }
  }

  /**
   * Append, creating the directory the first time this sink writes into it:
   * `app.getPath("logs")` names a directory Electron does not necessarily create, and the
   * first line is often the record of a failed startup. The memo holds one directory, not a
   * set, so a sink handed a second path still creates that path's directory without growing.
   */
  public async appendUtf8(filePath: string, text: string): Promise<void> {
    const directory = path.dirname(filePath);
    if (this.#ensuredDirectory !== directory) {
      await mkdir(directory, { recursive: true, mode: OWNER_ONLY_FOLDER_MODE });
      this.#ensuredDirectory = directory;
    }
    // The mode applies when the append creates the file.
    await appendFile(filePath, text, { encoding: "utf8", mode: OWNER_ONLY_FILE_MODE });
  }

  public async replace(fromPath: string, toPath: string): Promise<void> {
    await rename(fromPath, toPath);
  }

  /** Force-tolerant: rotation removes a previous generation that may never have existed. */
  public async remove(filePath: string): Promise<void> {
    await rm(filePath, { force: true });
  }
}

/** The sink over the real file system, so main builds a log with one call. */
export function createFileSystemDiagnosticLogSink(): DiagnosticLogFileSink {
  return new FileSystemDiagnosticLogSink();
}

/** Bytes the live log may reach before it rotates. One generation is kept beside it. */
const MAIN_DIAGNOSTIC_LOG_BYTE_CEILING = 2 * 1024 * 1024;

/** The file main's log is written to, in the logs folder. */
export const MAIN_DIAGNOSTIC_LOG_FILE_NAME = "main.jsonl";

/**
 * Build main's log under `logDirectory`. `notice` is the floor because main writes few lines
 * and they are the only record of a process that may not have produced a window.
 */
export function createMainDiagnosticLog(logDirectory: string): MainDiagnosticLog {
  return new MainDiagnosticLog({
    filePath: path.join(logDirectory, MAIN_DIAGNOSTIC_LOG_FILE_NAME),
    sink: createFileSystemDiagnosticLogSink(),
    minimumLevel: "notice",
    fileByteCeiling: MAIN_DIAGNOSTIC_LOG_BYTE_CEILING,
    now: () => new Date(),
  });
}

/** Where a log that could not be written says so. Main passes `console.error`. */
export type DiagnosticLogFailureReporter = (message: string) => void;

/**
 * Settle the log and say, once, if anything it was handed never reached the file. The class
 * refuses to throw at its callers, so without this a silent log is itself silent. Takes the
 * reporter rather than reaching for `console` so a test reads what was reported.
 */
export async function reportUnwrittenDiagnostics(
  log: Pick<MainDiagnosticLog, "drain" | "lastWriteFailure">,
  reportFailure: DiagnosticLogFailureReporter,
): Promise<void> {
  await log.drain();
  const failure = log.lastWriteFailure;
  if (failure === null) {
    return;
  }
  reportFailure(`[ai-sidekicks/desktop] the diagnostic log stopped accepting: ${failure}`);
}
