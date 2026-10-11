// The system's files and programs as Node reaches them, for the readers each system's module
// hands its reads to.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import type { ProcessIdentitySystem } from "@ai-sidekicks/contracts/process-identity";

const runProgram = promisify(execFile);

/** Node's own file read and program run, which reject as `readFile` and `execFile` do. */
export const NODE_SYSTEM_ACCESS: ProcessIdentitySystem = {
  readTextFile: (filePath) => readFile(filePath, "utf8"),
  runProgram: (file, args, environment) => runProgram(file, [...args], { env: environment }),
};
