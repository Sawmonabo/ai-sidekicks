// Where this machine's friendly name is read from, and the checks every system's reading shares.
// Each system's module reads the name the way that system names the machine.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import * as os from "node:os";
import { promisify } from "node:util";

import { isMissingFileError } from "../../file/missing-error.js";

/** Where the name is read from; injected so each system's form runs on any machine. */
export interface MachineNameSources {
  /** Runs a program with no shell and resolves with its standard output. */
  readonly runCommand: (file: string, args: readonly string[]) => Promise<string>;
  /** Resolves with a text file's contents, or `undefined` when the file does not exist. */
  readonly readTextFile: (filePath: string) => Promise<string | undefined>;
  /** `os.hostname()`. */
  readonly readHostname: () => string;
}

/** Creates the sources on this process: the real programs, files and host name. */
export function createNodeMachineNameSources(): MachineNameSources {
  const execFileAsync = promisify(execFile);
  return {
    runCommand: async (file, args) => (await execFileAsync(file, [...args])).stdout,
    readTextFile: async (filePath) => {
      try {
        return await readFile(filePath, "utf8");
      } catch (error) {
        if (isMissingFileError(error)) {
          return undefined;
        }
        throw error;
      }
    },
    readHostname: () => os.hostname(),
  };
}

/**
 * Answers `name`, read from `source`. Throws when it is empty, since no other source is the name
 * the person gave the machine.
 */
export function requireMachineName(name: string, source: string): string {
  if (name.length === 0) {
    throw new Error(`This machine's name is empty in ${source}`);
  }
  return name;
}

/**
 * The `PRETTY_HOSTNAME` in `/etc/machine-info`, an environment-style file: `KEY=VALUE` lines, `#`
 * comments, and values that may be quoted, with backslash escapes inside double quotes.
 */
export function readPrettyHostname(machineInfo: string): string | undefined {
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
