// The nonce folder a daemon start prepares in its run folder: emptied of what an earlier run left,
// closed to other accounts, and holding each shell's nonce file, readable by this account alone.

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { selectTerminalOperatingSystem } from "../../../operating-system/selector.js";
import { prepareShellLaunch, prepareShellStartupFolders } from "../injection.js";

let scratch: string | undefined;

afterEach(() => {
  if (scratch !== undefined) {
    rmSync(scratch, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform === "win32")("prepareShellStartupFolders", () => {
  it("empties the nonce folder an earlier run left, and keeps each nonce file private", async () => {
    scratch = mkdtempSync(path.join(tmpdir(), "shell-startup-folders-"));
    // A nonce file a crashed run left, in a folder left open.
    const leftFolder = path.join(scratch, "shell-nonces");
    mkdirSync(leftFolder, { mode: 0o755 });
    writeFileSync(path.join(leftFolder, "left"), "an earlier run's nonce");

    const startupFolders = await prepareShellStartupFolders(scratch);
    expect(readdirSync(startupFolders.nonceFolder)).toEqual([]);
    expect(statSync(startupFolders.nonceFolder).mode & 0o777).toBe(0o700);

    const { markNonce } = await prepareShellLaunch({
      shellPath: "/bin/zsh",
      environment: [],
      startupFolders,
      operatingSystem: selectTerminalOperatingSystem(process.platform, process.env),
    });
    if (markNonce === null) {
      throw new Error("zsh was given no nonce");
    }
    expect(path.dirname(markNonce.nonceFile)).toBe(startupFolders.nonceFolder);
    expect(statSync(markNonce.nonceFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(markNonce.nonceFile, "utf8")).toBe(`${markNonce.nonce}\n`);
  });
});
