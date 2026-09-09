// The main process's own JSONL log.
//
// `Spec-023 §Console Design (Meridian)` asks the main process to keep a small JSONL
// logger — async append, size rotation, level filter — that forwards to the same
// diagnostic band the renderer's capture reaches. Main is the one process whose
// failures nothing else can report: a window that never opened has no renderer to
// capture from, and the sidecar supervisor's refusals happen before any surface
// exists to render them.
//
// OWN-BUILT ON PURPOSE. `Spec-023 §Console Libraries`' main-process row ADOPTs
// nothing here and names `electron-log` an AVOID: this is one append path, one
// rotation rule, and one level filter, and a library for it would bring a transport
// registry, a renderer-side hook, and a format layer for a file three tests read.
//
// ONE SINK, AND THE SINK IS INJECTED. The file operations arrive through the
// constructor rather than being imported, so a test drives real rotation against a
// temporary directory and a failure case drives a sink that throws — neither of
// which is reachable if the module reaches for `node:fs` itself.
//
// THE CEILING IS A PROPERTY OF THE FILE, NOT OF THIS PROCESS. Main writes to the
// same path on every launch, so a byte count that started at zero would let the log
// grow by a whole ceiling per launch and would rotate a file already several
// ceilings long. The count is therefore seeded from the file, lazily, on the first
// write that reaches the queue — lazily because a log built on a startup path that
// then never writes has no business touching a disk.
//
// OWNER. No task's text names a main-process logger; the audit that found the gap
// left it unassigned. It belongs to the measurement task of Plan-023 Phase 1C,
// T-023p-1C-8, which owns the console's observability floor on the renderer side and
// is the only task whose scope this module's forward is inside.
//
// A WRITE NEVER THROWS AT ITS CALLER, AND NEVER SILENTLY SUCCEEDS EITHER. Callers are
// startup paths whose own failure handling is the thing being logged, so a logger
// that rejected into them would turn one failure into two. What a failed write does
// instead is stop accepting and count: `writeFailureCount` and `lastWriteFailure` are
// the record, and the process's exit path reads them.

/** How bad one entry is. Closed, and ordered most severe first. */
export const DIAGNOSTIC_LOG_LEVELS = ["error", "warning", "notice"] as const;

/** One level, derived so the set is declared exactly once. */
export type DiagnosticLogLevel = (typeof DIAGNOSTIC_LOG_LEVELS)[number];

/** One line of the log. */
export interface MainDiagnosticEntry {
  /** When it happened, ISO-8601, from the caller's clock rather than one here. */
  readonly at: string;
  readonly level: DiagnosticLogLevel;
  /** The main-process module that wrote it. */
  readonly source: string;
  readonly message: string;
}

/** The file operations the log performs. Injected, so a test owns all four. */
export interface DiagnosticLogFileSink {
  /**
   * Bytes the file already holds, or `0` when there is no such file.
   *
   * A missing file is `0` rather than a failure because "nothing has been written
   * yet" is the ordinary first-launch state, and a log that refused to start over an
   * absent file would fail on exactly the launch it exists to record.
   */
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
}

/** Where the rotated file goes. One generation: the previous file, and no more. */
export function rotatedPathFor(filePath: string): string {
  return `${filePath}.1`;
}

function levelRank(level: DiagnosticLogLevel): number {
  return DIAGNOSTIC_LOG_LEVELS.indexOf(level);
}

/**
 * One entry as one JSON line, newline-terminated.
 *
 * Field order is fixed by the object literal so two entries of the same shape encode
 * to the same bytes, which is what lets a test compare a written file against an
 * expected one rather than against a parse of itself.
 */
export function toLogLine(entry: MainDiagnosticEntry): string {
  return `${JSON.stringify({
    at: entry.at,
    level: entry.level,
    source: entry.source,
    message: entry.message,
  })}\n`;
}

/**
 * The main process's log.
 *
 * WRITES ARE SERIALIZED THROUGH ONE PROMISE CHAIN rather than issued concurrently.
 * Two overlapping appends to one file interleave at the byte level under Node's
 * append path on at least one supported platform, and a JSONL file with a half line
 * in it is a file no reader can parse past. The chain also makes the byte count this
 * class keeps exact: it is advanced by the write that succeeded, in the order the
 * writes happened.
 */
export class MainDiagnosticLog {
  readonly #filePath: string;
  readonly #sink: DiagnosticLogFileSink;
  readonly #minimumRank: number;
  readonly #fileByteCeiling: number;
  #writeChain: Promise<void> = Promise.resolve();
  /** `null` until the first queued write reads the file's own size. */
  #liveFileByteCount: number | null = null;
  #writtenEntryCount = 0;
  #filteredEntryCount = 0;
  #rotationCount = 0;
  #writeFailureCount = 0;
  #lastWriteFailure: string | null = null;
  #accepting = true;

  public constructor(options: MainDiagnosticLogOptions) {
    this.#filePath = options.filePath;
    this.#sink = options.sink;
    this.#minimumRank = levelRank(options.minimumLevel);
    this.#fileByteCeiling = options.fileByteCeiling;
  }

  /**
   * Write one entry, if its level passes the filter.
   *
   * Returns nothing: a caller that awaited each line would serialize its own startup
   * behind a disk. `drain()` is how a test — and the quit path — waits.
   */
  public write(entry: MainDiagnosticEntry): void {
    if (levelRank(entry.level) > this.#minimumRank) {
      this.#filteredEntryCount += 1;
      return;
    }
    if (!this.#accepting) {
      return;
    }
    const line = toLogLine(entry);
    const lineByteCount = Buffer.byteLength(line, "utf8");
    this.#writeChain = this.#writeChain.then(async () => {
      if (!this.#accepting) {
        return;
      }
      try {
        let liveByteCount = await this.#resolveLiveFileByteCount();
        if (liveByteCount + lineByteCount > this.#fileByteCeiling) {
          await this.#rotate();
          liveByteCount = 0;
        }
        await this.#sink.appendUtf8(this.#filePath, line);
        this.#liveFileByteCount = liveByteCount + lineByteCount;
        this.#writtenEntryCount += 1;
      } catch (writeFailure) {
        // Stop accepting rather than retry. A failing append is a full disk or a
        // revoked path, and a logger that kept trying would spend the quit budget
        // failing once per line.
        this.#accepting = false;
        this.#writeFailureCount += 1;
        this.#lastWriteFailure =
          writeFailure instanceof Error ? writeFailure.message : "unknown failure";
      }
    });
  }

  /**
   * How many bytes the live file holds, read once and then carried.
   *
   * Inside the write chain, so the read is serialized with the appends that advance
   * the count and two writes issued in the same tick cannot both seed it.
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
   * Rotate: the previous rotation is removed and the live file becomes the rotation.
   *
   * The remove comes first and tolerates a missing file, because `replace` onto an
   * existing path is not atomic on every supported platform and the failure it takes
   * there would be indistinguishable from the append failure above. The byte count
   * is the caller's to restart — it is advanced by the append that follows, and one
   * owner for the field is what keeps the two from disagreeing.
   */
  async #rotate(): Promise<void> {
    const rotatedPath = rotatedPathFor(this.#filePath);
    await this.#sink.remove(rotatedPath);
    await this.#sink.replace(this.#filePath, rotatedPath);
    this.#rotationCount += 1;
  }

  /** Settle every write issued so far. The quit path and every test await this. */
  public async drain(): Promise<void> {
    await this.#writeChain;
  }

  /** Entries written to the file. */
  public get writtenEntryCount(): number {
    return this.#writtenEntryCount;
  }

  /** Entries the level filter refused. Counted, so a filtered log is not a silent one. */
  public get filteredEntryCount(): number {
    return this.#filteredEntryCount;
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

/** Whether a rejected file operation failed because the path is not there. */
function isMissingPath(failure: unknown): boolean {
  return (
    typeof failure === "object" &&
    failure !== null &&
    "code" in failure &&
    failure.code === "ENOENT"
  );
}

/**
 * The sink over the real file system.
 *
 * A class rather than a returned literal because it carries one piece of state: the
 * directory has to be created before the first append and creating it before every
 * append would be a `mkdir` syscall per logged line.
 */
class FileSystemDiagnosticLogSink implements DiagnosticLogFileSink {
  /** The directory this sink has already created, or `null` before the first append. */
  #ensuredDirectory: string | null = null;

  public async byteCountOf(filePath: string): Promise<number> {
    const { stat } = await import("node:fs/promises");
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
   * Append, creating the directory the first time this sink writes into it.
   *
   * `app.getPath("logs")` names a directory Electron does not necessarily create,
   * and the first line main writes there is the record of a startup that failed —
   * the one line with nowhere else to go, so the append cannot assume a home.
   *
   * The memo holds the directory rather than a boolean, so a sink handed a second
   * path still creates that path's directory. One string rather than a growing set:
   * a sink serves one log, and remembering every directory it has ever seen would be
   * an unbounded map inside the module that records a machine running out of room.
   */
  public async appendUtf8(filePath: string, text: string): Promise<void> {
    const { appendFile, mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    const directory = dirname(filePath);
    if (this.#ensuredDirectory !== directory) {
      await mkdir(directory, { recursive: true });
      this.#ensuredDirectory = directory;
    }
    await appendFile(filePath, text, "utf8");
  }

  public async replace(fromPath: string, toPath: string): Promise<void> {
    const { rename } = await import("node:fs/promises");
    await rename(fromPath, toPath);
  }

  /** Force-tolerant: rotation removes a previous generation that may never have existed. */
  public async remove(filePath: string): Promise<void> {
    const { rm } = await import("node:fs/promises");
    await rm(filePath, { force: true });
  }
}

/**
 * The sink over the real file system.
 *
 * Here rather than at the call site so main constructs a log with one call and the
 * four operations are spelled once.
 */
export function createFileSystemDiagnosticLogSink(): DiagnosticLogFileSink {
  return new FileSystemDiagnosticLogSink();
}

/** Bytes the live log may reach before it rotates. One generation is kept beside it. */
const MAIN_DIAGNOSTIC_LOG_BYTE_CEILING = 2 * 1024 * 1024;

/**
 * Build main's log under `logDirectory`.
 *
 * `notice` is the floor because main writes few lines and the ones it writes are the
 * only record of a process that may not have produced a window; filtering them would
 * leave the quiet failure quiet.
 */
export function createMainDiagnosticLog(logDirectory: string): MainDiagnosticLog {
  return new MainDiagnosticLog({
    filePath: `${logDirectory}/main.jsonl`,
    sink: createFileSystemDiagnosticLogSink(),
    minimumLevel: "notice",
    fileByteCeiling: MAIN_DIAGNOSTIC_LOG_BYTE_CEILING,
  });
}

/** Where a log that could not be written says so. Main passes `console.error`. */
export type DiagnosticLogFailureReporter = (message: string) => void;

/**
 * Settle the log and say, once, if anything it was handed never reached the file.
 *
 * The class refuses to throw at its callers, which are startup paths whose own
 * failure handling is the thing being logged — so without this the log going silent
 * is itself silent, and the JSONL file main's exit path relies on can be empty with
 * nothing anywhere saying why. Takes the reporter rather than reaching for
 * `console` so a test reads what was reported instead of patching a global.
 */
export async function reportUnwrittenDiagnostics(
  log: MainDiagnosticLog,
  reportFailure: DiagnosticLogFailureReporter,
): Promise<void> {
  await log.drain();
  const failure = log.lastWriteFailure;
  if (failure === null) {
    return;
  }
  reportFailure(`[ai-sidekicks/desktop] the diagnostic log stopped accepting: ${failure}`);
}
