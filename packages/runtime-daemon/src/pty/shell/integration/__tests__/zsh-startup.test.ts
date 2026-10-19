// zsh's startup files copied into each account's own run folder: never a folder two accounts
// share, closed to other accounts, and a stale copy replaced by the app's own.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveDaemonRunFolder } from "@ai-sidekicks/contracts/daemon/run-folder";

import { POSIX_DISK_FLUSH } from "../../../../disk-flush/posix.js";
import { prepareZshStartupFolder } from "../zsh-startup.js";

const STARTUP_FILE_NAMES = [".zshenv", ".zprofile", ".zshrc", ".zlogin"];

let scratch: string | undefined;

afterEach(() => {
  if (scratch !== undefined) {
    rmSync(scratch, { recursive: true, force: true });
  }
});

function appFile(fileName: string): string {
  return readFileSync(new URL(`../scripts/zsh/${fileName}`, import.meta.url), "utf8");
}

// An account's run folder as the daemon resolves it where no session runtime folder is set.
function makeRunFolder(homeDirectory: string): string {
  const { folderPath } = resolveDaemonRunFolder({
    platform: "darwin",
    runtimeDirectory: undefined,
    homeDirectory,
  });
  mkdirSync(folderPath, { recursive: true, mode: 0o700 });
  return folderPath;
}

describe.skipIf(process.platform === "win32")("prepareZshStartupFolder", () => {
  it("gives each account its own folder, closed to others, holding the app's files", async () => {
    scratch = mkdtempSync(path.join(tmpdir(), "zsh-startup-"));
    const firstRunFolder = makeRunFolder(path.join(scratch, "first"));
    const secondRunFolder = makeRunFolder(path.join(scratch, "second"));
    // A folder left open by an earlier start, holding a file an older app wrote.
    mkdirSync(path.join(firstRunFolder, "zsh"), { mode: 0o755 });
    writeFileSync(path.join(firstRunFolder, "zsh", ".zshrc"), "# an older app's file\n");

    const first = await prepareZshStartupFolder(firstRunFolder, POSIX_DISK_FLUSH);
    const second = await prepareZshStartupFolder(secondRunFolder, POSIX_DISK_FLUSH);

    expect(first).not.toBe(second);
    for (const folder of [first, second]) {
      expect(statSync(folder).mode & 0o777).toBe(0o700);
      for (const fileName of STARTUP_FILE_NAMES) {
        expect(readFileSync(path.join(folder, fileName), "utf8")).toBe(appFile(fileName));
      }
    }
  });
});
