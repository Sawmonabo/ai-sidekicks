import { Command, CommanderError } from "commander";

import packageManifest from "../package.json" with { type: "json" };
import type { CommandContext } from "./command-context.js";
import { exitCodeForFailure, LOCAL_FAILURE_EXIT_CODES, PosixExitCode } from "./exit-codes.js";

/** Commander's codes for `--help` and `--version`, which print their output and succeed. */
const SUCCESSFUL_DISPLAY_CODES: ReadonlySet<string> = new Set([
  "commander.helpDisplayed",
  "commander.version",
]);

/**
 * Builds the `sidekicks` program, whose output and parse refusals go to the context's streams.
 * A command is added with `.command()` on the program or on a group, never with `new Command()`
 * and `.addCommand()`, which drops these output and exit settings; it writes its result only
 * through `context.stdout` and fails by throwing.
 */
export function createProgram(context: CommandContext): Command {
  return new Command("sidekicks")
    .description("Drive AI Sidekicks sessions from the terminal.")
    .version(packageManifest.version)
    .exitOverride()
    .configureOutput({
      writeOut: (text) => context.stdout.write(text),
      writeErr: (text) => context.stderr.write(text),
    });
}

function writeFailure(context: CommandContext, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  context.stderr.write(`error: ${message}\n`);
}

// The mapper throws for a daemon code with no exit code; that failure is reported like any other.
function exitCodeForRunFailure(error: unknown, context: CommandContext): PosixExitCode {
  try {
    return exitCodeForFailure(error);
  } catch (mappingError) {
    writeFailure(context, mappingError);
    return LOCAL_FAILURE_EXIT_CODES.software;
  }
}

/**
 * Runs the program over the arguments after the executable and script and returns the exit code.
 * The one error boundary: every failure is reported on the context's `stderr`, never on `stdout`
 * and never with a stack, and turned into an exit code.
 */
export async function runProgram(
  program: Command,
  args: readonly string[],
  context: CommandContext,
): Promise<PosixExitCode> {
  try {
    await program.parseAsync(args, { from: "user" });
    return PosixExitCode.Success;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (SUCCESSFUL_DISPLAY_CODES.has(error.code)) {
        return PosixExitCode.Success;
      }
      // Commander has already written the refusal to stderr.
      return exitCodeForRunFailure(error, context);
    }
    writeFailure(context, error);
    return exitCodeForRunFailure(error, context);
  }
}
