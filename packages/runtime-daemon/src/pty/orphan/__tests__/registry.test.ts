// Every registry write survives a crash at any moment: the new contents reach the disk in a
// temporary file, the rename replaces the old file, and the folder is flushed so the rename
// itself survives a power loss.

import { mkdtemp, open, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AtomicWriteFileSystem } from "../../../file/atomic-write.js";
import { ORPHAN_REGISTRY_FILE_NAME, OrphanRegistry } from "../registry.js";

let dataFolder: string;

beforeEach(async () => {
  dataFolder = await mkdtemp(path.join(tmpdir(), "orphan-registry-"));
});

afterEach(async () => {
  await rm(dataFolder, { recursive: true, force: true });
});

// Node's own calls, each logged with the file it touched, named by its place in the data folder.
function recordingFileSystem(log: string[]): AtomicWriteFileSystem {
  const name = (filePath: string): string =>
    filePath === dataFolder ? "folder" : filePath.endsWith(".tmp") ? "temporary" : "registry";
  return {
    open: async (filePath, flags, mode) => {
      const handle = await open(filePath, flags, mode);
      log.push(`open ${name(filePath)}`);
      return {
        writeFile: async (text, encoding) => {
          await handle.writeFile(text, encoding);
          log.push(`write ${name(filePath)}`);
        },
        sync: async () => {
          await handle.sync();
          log.push(`sync ${name(filePath)}`);
        },
        close: async () => {
          await handle.close();
          log.push(`close ${name(filePath)}`);
        },
      };
    },
    rename: async (fromPath, toPath) => {
      await rename(fromPath, toPath);
      log.push(`rename ${name(fromPath)} to ${name(toPath)}`);
    },
    rm: async (filePath, options) => {
      await rm(filePath, options);
      log.push(`remove ${name(filePath)}`);
    },
  };
}

describe("OrphanRegistry", () => {
  it("writes each change to disk, renames it into place, then flushes the folder", async () => {
    const log: string[] = [];
    const registry = new OrphanRegistry(dataFolder, recordingFileSystem(log));

    await registry.recordIntent("nonce-1", "boot-1");

    expect(log).toEqual([
      "open temporary",
      "write temporary",
      "sync temporary",
      "close temporary",
      "rename temporary to registry",
      "open folder",
      "sync folder",
      "close folder",
    ]);
    const written: unknown = JSON.parse(
      await readFile(path.join(dataFolder, ORPHAN_REGISTRY_FILE_NAME), "utf8"),
    );
    expect(written).toEqual({ entries: [{ nonce: "nonce-1", bootId: "boot-1" }] });
  });
});
