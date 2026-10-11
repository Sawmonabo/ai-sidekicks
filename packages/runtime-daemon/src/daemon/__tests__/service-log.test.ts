// The service log begins its next file once a line would carry the live one past its byte bound,
// so no file grows without bound however fast lines come.

import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Writable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { openServiceLog, SERVICE_LOG_FILE_BYTE_CEILING } from "../service-log.js";

let dataFolder: string | undefined;

afterEach(async () => {
  if (dataFolder !== undefined) {
    await rm(dataFolder, { recursive: true, force: true });
    dataFolder = undefined;
  }
});

describe("the service log", () => {
  it("begins the next file once a line would carry the live one past its bound", async () => {
    dataFolder = await mkdtemp(path.join(os.tmpdir(), "sidekicks-service-log-"));
    let now = Date.parse("2026-10-11T12:00:00.000Z");
    const serviceLog = openServiceLog({
      dataFolder,
      now: () => new Date(now),
      // Standard error takes every line and keeps none.
      standardError: new Writable({
        write: (_chunk, _encoding, done) => {
          done();
        },
      }),
    });
    const firstFile = serviceLog.liveFile();

    // One line that fills the file to its bound exactly, newline included.
    serviceLog.write("x".repeat(SERVICE_LOG_FILE_BYTE_CEILING - 1));
    now += 1000;
    serviceLog.write("The next line.");

    expect((await stat(firstFile)).size).toBe(SERVICE_LOG_FILE_BYTE_CEILING);
    expect(serviceLog.liveFile()).not.toBe(firstFile);
    expect(await readFile(serviceLog.liveFile(), "utf8")).toBe("The next line.\n");
  });
});
