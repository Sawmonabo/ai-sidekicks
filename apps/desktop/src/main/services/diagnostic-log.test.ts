// Rotation is one generation at a byte ceiling measured on the file (not on one process's
// writes), appends never interleave, the sink creates its directory, and a failure stops the log
// and is readable afterwards.

import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createFileSystemDiagnosticLogSink,
  MainDiagnosticLog,
  reportUnwrittenDiagnostics,
  type DiagnosticLogFileSink,
  type MainDiagnosticEntry,
  type MainDiagnosticLine,
  rotatedPathFor,
  toLogLine,
} from "./diagnostic-log.js";

const AT = "2026-09-08T00:00:00.000Z";

/** The log's clock in every case, so a written line is known to the byte. */
const STOPPED_CLOCK = (): Date => new Date(AT);

function entry(level: MainDiagnosticEntry["level"], message: string): MainDiagnosticEntry {
  return { level, source: "main/test", message };
}

/** The bytes `entry(level, message)` is written as, stamped by `STOPPED_CLOCK`. */
function lineOf(level: MainDiagnosticEntry["level"], message: string): string {
  return toLogLine({ at: AT, ...entry(level, message) });
}

/** The shipped sink, not a double: rotation is two file operations whose order matters. */
const realFileSink: DiagnosticLogFileSink = createFileSystemDiagnosticLogSink();

/** A sink whose appends always fail, with the message the failure carries. */
function rejectingSink(failureMessage: string): DiagnosticLogFileSink {
  return {
    byteCountOf: () => Promise.resolve(0),
    appendUtf8: () => Promise.reject(new Error(failureMessage)),
    replace: () => Promise.resolve(),
    remove: () => Promise.resolve(),
  };
}

describe("main diagnostic log", () => {
  let directory = "";
  let filePath = "";

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "sidekicks-main-log-"));
    filePath = join(directory, "main.jsonl");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("rotates one generation at the byte ceiling and keeps the previous file", async () => {
    const oneLine = lineOf("error", "a");
    const log = new MainDiagnosticLog({
      filePath,
      sink: realFileSink,
      minimumLevel: "notice",
      now: STOPPED_CLOCK,
      // Two lines fit; the third rotates.
      fileByteCeiling: Buffer.byteLength(oneLine, "utf8") * 2,
    });
    log.write(entry("error", "a"));
    log.write(entry("error", "a"));
    log.write(entry("error", "b"));
    await log.drain();

    expect(log.rotationCount).toBe(1);
    expect(await readFile(filePath, "utf8")).toBe(lineOf("error", "b"));
    const rotated = await readFile(rotatedPathFor(filePath), "utf8");
    expect(rotated.split("\n").filter((line) => line.length > 0)).toHaveLength(2);
  });

  it("keeps exactly one generation across a second rotation", async () => {
    const oneLine = lineOf("error", "a");
    const log = new MainDiagnosticLog({
      filePath,
      sink: realFileSink,
      minimumLevel: "notice",
      now: STOPPED_CLOCK,
      fileByteCeiling: Buffer.byteLength(oneLine, "utf8"),
    });
    log.write(entry("error", "a"));
    log.write(entry("error", "b"));
    log.write(entry("error", "c"));
    await log.drain();

    expect(log.rotationCount).toBe(2);
    expect(await readFile(filePath, "utf8")).toBe(lineOf("error", "c"));
    expect(await readFile(rotatedPathFor(filePath), "utf8")).toBe(lineOf("error", "b"));
  });

  it("appends in call order however many writes are issued at once", async () => {
    const log = new MainDiagnosticLog({
      filePath,
      sink: realFileSink,
      minimumLevel: "notice",
      now: STOPPED_CLOCK,
      fileByteCeiling: 64 * 1024,
    });
    for (let index = 0; index < 40; index += 1) {
      log.write(entry("notice", `line ${index}`));
    }
    await log.drain();

    const messages = (await readFile(filePath, "utf8"))
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => (JSON.parse(line) as MainDiagnosticLine).message);
    expect(messages).toStrictEqual(Array.from({ length: 40 }, (_unused, index) => `line ${index}`));
  });

  it("rotates on the bytes the file holds, not the bytes one instance wrote", async () => {
    const oneLine = lineOf("error", "a");
    const fileByteCeiling = Buffer.byteLength(oneLine, "utf8") * 2;
    const beforeRestart = new MainDiagnosticLog({
      filePath,
      sink: realFileSink,
      minimumLevel: "notice",
      now: STOPPED_CLOCK,
      fileByteCeiling,
    });
    beforeRestart.write(entry("error", "a"));
    beforeRestart.write(entry("error", "a"));
    await beforeRestart.drain();
    expect(beforeRestart.rotationCount).toBe(0);

    // A restart over the file the first instance left full: the first line must rotate, since a
    // count starting at zero would let the log grow by a whole ceiling per launch.
    const afterRestart = new MainDiagnosticLog({
      filePath,
      sink: realFileSink,
      minimumLevel: "notice",
      now: STOPPED_CLOCK,
      fileByteCeiling,
    });
    afterRestart.write(entry("error", "b"));
    await afterRestart.drain();

    expect(afterRestart.rotationCount).toBe(1);
    expect(await readFile(filePath, "utf8")).toBe(lineOf("error", "b"));
    const rotated = await readFile(rotatedPathFor(filePath), "utf8");
    expect(rotated.split("\n").filter((line) => line.length > 0)).toHaveLength(2);
  });

  it("creates the log folder and file, readable by the person alone", async () => {
    // `app.getPath("logs")` names a directory Electron has not necessarily made.
    const nestedFilePath = join(directory, "logs", "main.jsonl");
    const log = new MainDiagnosticLog({
      filePath: nestedFilePath,
      sink: realFileSink,
      minimumLevel: "notice",
      now: STOPPED_CLOCK,
      fileByteCeiling: 64 * 1024,
    });
    log.write(entry("error", "sidecar refused to start"));
    await log.drain();

    expect(log.writeFailureCount).toBe(0);
    expect(await readFile(nestedFilePath, "utf8")).toBe(
      lineOf("error", "sidecar refused to start"),
    );
    // Windows keeps no POSIX mode bits.
    if (process.platform !== "win32") {
      expect((await stat(nestedFilePath)).mode & 0o777).toBe(0o600);
      expect((await stat(join(directory, "logs"))).mode & 0o777).toBe(0o700);
    }
  });

  it("stops accepting on a failed write, records why, and never throws at the caller", async () => {
    const log = new MainDiagnosticLog({
      filePath,
      sink: rejectingSink("no space left on device"),
      minimumLevel: "notice",
      now: STOPPED_CLOCK,
      fileByteCeiling: 64 * 1024,
    });
    expect(() => log.write(entry("error", "first"))).not.toThrow();
    await log.drain();
    log.write(entry("error", "second"));
    await log.drain();

    expect(log.isAccepting).toBe(false);
    expect(log.writeFailureCount).toBe(1);
    expect(log.lastWriteFailure).toBe("no space left on device");
    expect(log.writtenEntryCount).toBe(0);
  });
});

describe("reporting what the log could not write", () => {
  let directory = "";
  let filePath = "";

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "sidekicks-main-log-"));
    filePath = join(directory, "main.jsonl");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("hands a failed write to the reporter after the queue settles", async () => {
    const log = new MainDiagnosticLog({
      filePath,
      sink: rejectingSink("no space left on device"),
      minimumLevel: "notice",
      now: STOPPED_CLOCK,
      fileByteCeiling: 64 * 1024,
    });
    log.write(entry("error", "startup failed"));

    const reported: string[] = [];
    await reportUnwrittenDiagnostics(log, (message) => reported.push(message));

    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain("no space left on device");
  });
});
