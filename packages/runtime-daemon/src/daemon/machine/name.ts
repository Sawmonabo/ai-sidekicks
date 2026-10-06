// This machine's friendly name, read the way its platform names it: on macOS the computer name
// from `scutil --get ComputerName` (never `os.hostname()`, which reads `Name-Mac-mini.local`); on
// Linux `PRETTY_HOSTNAME` from `/etc/machine-info`, falling back to the static hostname; on Windows
// the DNS host name without its domain, never `%COMPUTERNAME%`, the 15-byte uppercase NetBIOS name.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import * as os from "node:os";
import { promisify } from "node:util";

/** Where the name is read from; injected so each platform's form runs on any machine. */
export interface MachineNameSources {
  readonly platform: NodeJS.Platform;
  /** Runs a program with no shell and resolves with its standard output. */
  readonly runCommand: (file: string, args: readonly string[]) => Promise<string>;
  /** Resolves with a text file's contents, or `undefined` when the file does not exist. */
  readonly readTextFile: (filePath: string) => Promise<string | undefined>;
  /** `os.hostname()`. */
  readonly readHostname: () => string;
}

/**
 * Reads this machine's friendly name. Throws when the platform's own source names nothing, since
 * no other source is the name the person gave the machine.
 */
export async function readMachineName(sources: MachineNameSources): Promise<string> {
  switch (sources.platform) {
    case "darwin":
      return requireName(
        (await sources.runCommand("scutil", ["--get", "ComputerName"])).trim(),
        "scutil --get ComputerName",
      );
    case "linux": {
      const machineInfo = await sources.readTextFile("/etc/machine-info");
      const prettyHostname =
        machineInfo === undefined ? undefined : readPrettyHostname(machineInfo);
      if (prettyHostname !== undefined && prettyHostname.length > 0) {
        return prettyHostname;
      }
      const staticHostname = await sources.readTextFile("/etc/hostname");
      return requireName((staticHostname ?? "").trim(), "/etc/machine-info or /etc/hostname");
    }
    case "win32":
      // There `os.hostname()` is the DNS host name without its domain.
      return requireName(sources.readHostname(), "os.hostname()");
    default:
      throw new Error(`No machine name source is known for platform ${sources.platform}`);
  }
}

/** Creates the sources on this process: the real platform, programs, files and host name. */
export function createNodeMachineNameSources(): MachineNameSources {
  const execFileAsync = promisify(execFile);
  return {
    platform: process.platform,
    runCommand: async (file, args) => (await execFileAsync(file, [...args])).stdout,
    readTextFile: async (filePath) => {
      try {
        return await readFile(filePath, "utf8");
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          return undefined;
        }
        throw error;
      }
    },
    readHostname: () => os.hostname(),
  };
}

function requireName(name: string, source: string): string {
  if (name.length === 0) {
    throw new Error(`This machine's name is empty in ${source}`);
  }
  return name;
}

// `/etc/machine-info` is an environment-style file: `KEY=VALUE` lines, `#` comments, and values
// that may be quoted, with backslash escapes inside double quotes.
function readPrettyHostname(machineInfo: string): string | undefined {
  for (const rawLine of machineInfo.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("PRETTY_HOSTNAME=")) {
      continue;
    }
    const value = line.slice("PRETTY_HOSTNAME=".length);
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      return value.slice(1, -1).replace(/\\(.)/g, "$1");
    }
    if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      return value.slice(1, -1);
    }
    return value;
  }
  return undefined;
}
