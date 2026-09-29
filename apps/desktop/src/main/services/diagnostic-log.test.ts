// What the main-process log promises: a level filter that counts what it refused,
// one-generation rotation at a named byte ceiling — against the bytes in the FILE and
// not the bytes one process wrote — serialized appends that never interleave, a log
// directory the sink creates rather than assumes, and a failure that stops the log and
// is readable afterwards rather than reaching its caller.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createFileSystemDiagnosticLogSink,
  MainDiagnosticLog,
  reportUnwrittenDiagnostics,
  type DiagnosticLogFileSink,
  type MainDiagnosticEntry,
  rotatedPathFor,
  toLogLine,
} from "./diagnostic-log.js";

const AT = "2026-09-08T00:00:00.000Z";

function entry(level: MainDiagnosticEntry["level"], message: string): MainDiagnosticEntry {
  return { at: AT, level, source: "main/test", message };
}

/**
 * The shipped file sink, not a copy of it.
 *
 * The suite drives the real one rather than a double for rotation, because rotation is
 * two file operations in an order that matters and a double would prove only that the
 * module called them — and because a hand-written copy here is the second
 * implementation of a seam that has one, which drifts the moment the shipped sink grows
 * an operation.
 */
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

  it("writes one JSON object per line, newline terminated", async () => {
    const log = new MainDiagnosticLog({
      filePath,
      sink: realFileSink,
      minimumLevel: "notice",
      fileByteCeiling: 64 * 1024,
    });
    log.write(entry("error", "sidecar refused to start"));
    log.write(entry("notice", "window shown"));
    await log.drain();

    const written = await readFile(filePath, "utf8");
    const lines = written.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "")).toStrictEqual({
      at: AT,
      level: "error",
      source: "main/test",
      message: "sidecar refused to start",
    });
    expect(log.writtenEntryCount).toBe(2);
  });

  it("filters below the minimum level and counts what it refused", async () => {
    const log = new MainDiagnosticLog({
      filePath,
      sink: realFileSink,
      minimumLevel: "error",
      fileByteCeiling: 64 * 1024,
    });
    log.write(entry("error", "kept"));
    log.write(entry("warning", "dropped"));
    log.write(entry("notice", "dropped"));
    await log.drain();

    expect(await readFile(filePath, "utf8")).toBe(toLogLine(entry("error", "kept")));
    expect(log.filteredEntryCount).toBe(2);
    expect(log.writtenEntryCount).toBe(1);
  });

  it("rotates one generation at the byte ceiling and keeps the previous file", async () => {
    const oneLine = toLogLine(entry("error", "a"));
    const log = new MainDiagnosticLog({
      filePath,
      sink: realFileSink,
      minimumLevel: "notice",
      // Two lines fit; the third rotates.
      fileByteCeiling: Buffer.byteLength(oneLine, "utf8") * 2,
    });
    log.write(entry("error", "a"));
    log.write(entry("error", "a"));
    log.write(entry("error", "b"));
    await log.drain();

    expect(log.rotationCount).toBe(1);
    expect(await readFile(filePath, "utf8")).toBe(toLogLine(entry("error", "b")));
    const rotated = await readFile(rotatedPathFor(filePath), "utf8");
    expect(rotated.split("\n").filter((line) => line.length > 0)).toHaveLength(2);
  });

  it("keeps exactly one generation across a second rotation", async () => {
    const oneLine = toLogLine(entry("error", "a"));
    const log = new MainDiagnosticLog({
      filePath,
      sink: realFileSink,
      minimumLevel: "notice",
      fileByteCeiling: Buffer.byteLength(oneLine, "utf8"),
    });
    log.write(entry("error", "a"));
    log.write(entry("error", "b"));
    log.write(entry("error", "c"));
    await log.drain();

    expect(log.rotationCount).toBe(2);
    expect(await readFile(filePath, "utf8")).toBe(toLogLine(entry("error", "c")));
    expect(await readFile(rotatedPathFor(filePath), "utf8")).toBe(toLogLine(entry("error", "b")));
  });

  it("appends in call order however many writes are issued at once", async () => {
    const log = new MainDiagnosticLog({
      filePath,
      sink: realFileSink,
      minimumLevel: "notice",
      fileByteCeiling: 64 * 1024,
    });
    for (let index = 0; index < 40; index += 1) {
      log.write(entry("notice", `line ${index}`));
    }
    await log.drain();

    const messages = (await readFile(filePath, "utf8"))
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => (JSON.parse(line) as MainDiagnosticEntry).message);
    expect(messages).toStrictEqual(Array.from({ length: 40 }, (_unused, index) => `line ${index}`));
  });

  it("rotates on the bytes the file holds, not the bytes one instance wrote", async () => {
    const oneLine = toLogLine(entry("error", "a"));
    const fileByteCeiling = Buffer.byteLength(oneLine, "utf8") * 2;
    const beforeRestart = new MainDiagnosticLog({
      filePath,
      sink: realFileSink,
      minimumLevel: "notice",
      fileByteCeiling,
    });
    beforeRestart.write(entry("error", "a"));
    beforeRestart.write(entry("error", "a"));
    await beforeRestart.drain();
    expect(beforeRestart.rotationCount).toBe(0);

    // A restart: a second instance over the file the first one left full. The
    // ceiling is a property of the FILE, so the very first line this instance
    // writes has to rotate — a count that started at zero would let the log grow
    // by a whole ceiling per launch and keep a rotation that holds two lines.
    const afterRestart = new MainDiagnosticLog({
      filePath,
      sink: realFileSink,
      minimumLevel: "notice",
      fileByteCeiling,
    });
    afterRestart.write(entry("error", "b"));
    await afterRestart.drain();

    expect(afterRestart.rotationCount).toBe(1);
    expect(await readFile(filePath, "utf8")).toBe(toLogLine(entry("error", "b")));
    const rotated = await readFile(rotatedPathFor(filePath), "utf8");
    expect(rotated.split("\n").filter((line) => line.length > 0)).toHaveLength(2);
  });

  it("creates the log directory rather than assuming one exists", async () => {
    // `app.getPath("logs")` names a directory Electron has not necessarily made,
    // and the first thing main writes there is the record of a startup that
    // failed — the one line that has nowhere else to go.
    const nestedFilePath = join(directory, "logs", "main.jsonl");
    const log = new MainDiagnosticLog({
      filePath: nestedFilePath,
      sink: realFileSink,
      minimumLevel: "notice",
      fileByteCeiling: 64 * 1024,
    });
    log.write(entry("error", "sidecar refused to start"));
    await log.drain();

    expect(log.writeFailureCount).toBe(0);
    expect(await readFile(nestedFilePath, "utf8")).toBe(
      toLogLine(entry("error", "sidecar refused to start")),
    );
  });

  it("reads an absent log as zero bytes when its parent path is a file", async () => {
    // ENOTDIR rather than ENOENT, which `stat` answers when a component that would have
    // to be a directory is a file. Both codes say the same thing about the log — there
    // is no such file — and only ENOENT was being read that way, so a log pointed under
    // a stray file reported a failed SIZE READ. The append that follows still fails, and
    // that failure is the honest one: it names the directory that cannot be created.
    const parentThatIsAFile = join(directory, "occupied");
    await writeFile(parentThatIsAFile, "not a directory", "utf8");

    await expect(realFileSink.byteCountOf(join(parentThatIsAFile, "main.jsonl"))).resolves.toBe(0);
  });

  it("stops accepting on a failed write, records why, and never throws at the caller", async () => {
    const log = new MainDiagnosticLog({
      filePath,
      sink: rejectingSink("no space left on device"),
      minimumLevel: "notice",
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
      fileByteCeiling: 64 * 1024,
    });
    log.write(entry("error", "startup failed"));

    const reported: string[] = [];
    await reportUnwrittenDiagnostics(log, (message) => reported.push(message));

    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain("no space left on device");
  });

  it("says nothing when every write landed", async () => {
    const log = new MainDiagnosticLog({
      filePath,
      sink: realFileSink,
      minimumLevel: "notice",
      fileByteCeiling: 64 * 1024,
    });
    log.write(entry("error", "startup failed"));

    const reported: string[] = [];
    await reportUnwrittenDiagnostics(log, (message) => reported.push(message));

    expect(reported).toStrictEqual([]);
  });
});
