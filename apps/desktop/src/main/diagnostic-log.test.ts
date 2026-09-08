// What the main-process log promises: a level filter that counts what it refused,
// one-generation rotation at a named byte ceiling, serialized appends that never
// interleave, and a failure that stops the log rather than reaching its caller.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MainDiagnosticLog,
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
 * The real file sink, over `node:fs/promises`.
 *
 * The suite drives the real one rather than a double for rotation, because rotation
 * is two file operations in an order that matters and a double would prove only that
 * the module called them.
 */
const realFileSink: DiagnosticLogFileSink = {
  async appendUtf8(filePath, text) {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(filePath, text, "utf8");
  },
  async replace(fromPath, toPath) {
    const { rename } = await import("node:fs/promises");
    await rename(fromPath, toPath);
  },
  async remove(filePath) {
    await rm(filePath, { force: true });
  },
};

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

  it("stops accepting on a failed write, records why, and never throws at the caller", async () => {
    const failingSink: DiagnosticLogFileSink = {
      appendUtf8: () => Promise.reject(new Error("no space left on device")),
      replace: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    };
    const log = new MainDiagnosticLog({
      filePath,
      sink: failingSink,
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
