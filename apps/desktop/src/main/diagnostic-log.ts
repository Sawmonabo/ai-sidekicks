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

/** The file operations the log performs. Injected, so a test owns all three. */
export interface DiagnosticLogFileSink {
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
  #liveFileByteCount = 0;
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
        if (this.#liveFileByteCount + lineByteCount > this.#fileByteCeiling) {
          await this.#rotate();
        }
        await this.#sink.appendUtf8(this.#filePath, line);
        this.#liveFileByteCount += lineByteCount;
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
   * Rotate: the previous rotation is removed, the live file becomes the rotation,
   * and the byte count restarts.
   *
   * The remove comes first and tolerates a missing file, because `replace` onto an
   * existing path is not atomic on every supported platform and the failure it takes
   * there would be indistinguishable from the append failure above.
   */
  async #rotate(): Promise<void> {
    const rotatedPath = rotatedPathFor(this.#filePath);
    await this.#sink.remove(rotatedPath);
    await this.#sink.replace(this.#filePath, rotatedPath);
    this.#liveFileByteCount = 0;
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

/**
 * The sink over the real file system.
 *
 * Here rather than at the call site so main constructs a log with one call and the
 * three operations are spelled once. `remove` is force-tolerant because rotation
 * removes a previous generation that may never have existed.
 */
export function createFileSystemDiagnosticLogSink(): DiagnosticLogFileSink {
  return {
    async appendUtf8(filePath, text) {
      const { appendFile } = await import("node:fs/promises");
      await appendFile(filePath, text, "utf8");
    },
    async replace(fromPath, toPath) {
      const { rename } = await import("node:fs/promises");
      await rename(fromPath, toPath);
    },
    async remove(filePath) {
      const { rm } = await import("node:fs/promises");
      await rm(filePath, { force: true });
    },
  };
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
