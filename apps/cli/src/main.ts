// The `sidekicks` executable: runs the program on the real process streams and sets the exit code
// without `process.exit()`, which can cut off output still being piped.
import process from "node:process";

import type { CommandContext } from "./command-context.js";
import { ExitCode, exitCodeForFailure } from "./exit-codes.js";
import { createProgram, runProgram } from "./program.js";

// A stream whose reader went away (EPIPE) or that otherwise broke reports it as an `error` event,
// often after the write returned, so its first failure decides the exit code and later writes to
// it are dropped. A broken stdout that is not a closed pipe is also reported on stderr.
let streamFailureExitCode: ExitCode | undefined;
const failedStreams = new Set<NodeJS.WriteStream>();

function writeTo(stream: NodeJS.WriteStream, chunk: string): void {
  if (!failedStreams.has(stream)) {
    stream.write(chunk);
  }
}

for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error) => {
    failedStreams.add(stream);
    const exitCode = exitCodeForFailure(error);
    streamFailureExitCode ??= exitCode;
    process.exitCode = streamFailureExitCode;
    if (stream === process.stdout && exitCode !== ExitCode.BrokenPipe) {
      writeTo(process.stderr, `error: ${error.message}\n`);
    }
  });
}

const context: CommandContext = {
  stdout: { write: (chunk) => writeTo(process.stdout, chunk) },
  stderr: { write: (chunk) => writeTo(process.stderr, chunk) },
};

const runExitCode = await runProgram(createProgram(context), process.argv.slice(2));
process.exitCode = streamFailureExitCode ?? runExitCode;
