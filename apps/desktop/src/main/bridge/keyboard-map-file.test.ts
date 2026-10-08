// A read of a missing, stored or broken file, and a write that leaves one owner-only file.

import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { KEYBOARD_MAP_FILE_NAME, KeyboardMapFile } from "./keyboard-map-file.js";

const REPAIRED_AT = new Date("2026-09-30T12:00:00.000Z");

let userData: string;
let filePath: string;

function keyboardMapFile(): KeyboardMapFile {
  return new KeyboardMapFile({ filePath, now: () => REPAIRED_AT });
}

beforeEach(async () => {
  userData = await mkdtemp(path.join(tmpdir(), "sidekicks-keyboard-map-test-"));
  filePath = path.join(userData, KEYBOARD_MAP_FILE_NAME);
});

afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
});

describe("reading the keyboard map", () => {
  it("reads a missing file as the empty map and leaves it missing", async () => {
    await expect(keyboardMapFile().read()).resolves.toStrictEqual({ map: {} });
    await expect(readdir(userData)).resolves.toStrictEqual([]);
  });

  it("reads back what a write stored, only the rows written", async () => {
    const file = keyboardMapFile();
    const stored = await file.write({
      "frame.goToSessions": "$mod+9",
      "frame.cycleColorScheme": null,
    });

    expect(stored).toStrictEqual({
      "frame.goToSessions": "$mod+9",
      "frame.cycleColorScheme": null,
    });
    await expect(keyboardMapFile().read()).resolves.toStrictEqual({ map: stored });
  });

  it(
    "reads a file that is not JSON as the empty map, " +
      "rewrites it, and says so until the next write",
    async () => {
      await writeFile(filePath, "{ not json", "utf8");
      const file = keyboardMapFile();

      const repaired = { repairedAt: REPAIRED_AT.toISOString(), cause: "unparseable" };
      await expect(file.read()).resolves.toStrictEqual({ map: {}, repair: repaired });
      expect(JSON.parse(await readFile(filePath, "utf8"))).toStrictEqual({});
      await expect(file.read()).resolves.toStrictEqual({ map: {}, repair: repaired });

      await file.write({ "frame.goToSessions": "$mod+9" });
      await expect(file.read()).resolves.toStrictEqual({ map: { "frame.goToSessions": "$mod+9" } });
    },
  );

  it("reads a map the schema refuses as the empty map, naming that cause", async () => {
    await writeFile(filePath, JSON.stringify({ "frame.goToSessions": 7 }), "utf8");

    const reading = await keyboardMapFile().read();

    expect(reading.map).toStrictEqual({});
    expect(reading.repair?.cause).toBe("schemaRefused");
  });
});

describe("writing the keyboard map", () => {
  it.skipIf(process.platform === "win32")(
    "leaves one whole file only the person can read or write",
    async () => {
      await keyboardMapFile().write({ "frame.goToSessions": "$mod+9" });

      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
      // No temporary file is left behind.
      await expect(readdir(userData)).resolves.toStrictEqual([KEYBOARD_MAP_FILE_NAME]);
    },
  );
});
