// The `sidekicks` executable: runs the program on the real process streams and sets the exit code
// without `process.exit()`, which can cut off output still being piped.
import process from "node:process";

import { createProgram, runProgram } from "./program.js";

const program = createProgram({ stdout: process.stdout, stderr: process.stderr });

process.exitCode = await runProgram(program, process.argv.slice(2));
