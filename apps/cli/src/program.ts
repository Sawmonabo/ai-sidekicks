import { inspect } from "node:util";

import { Command, CommanderError, type OutputConfiguration } from "commander";

import packageManifest from "../package.json" with { type: "json" };
import type { CommandContext } from "./command-context.js";
import { ExitCode, exitCodeForFailure, LOCAL_FAILURE_EXIT_CODES } from "./exit-codes.js";

// An exit commander asked for after it printed the help, the version or the refusal itself, told
// apart from a `CommanderError` a command body throws, which nothing has printed yet.
class PrintedCommanderExit extends Error {
  public readonly commanderError: CommanderError;

  public constructor(commanderError: CommanderError) {
    super(commanderError.message, { cause: commanderError });
    this.name = "PrintedCommanderExit";
    this.commanderError = commanderError;
  }
}

/**
 * Builds the `sidekicks` program, whose output and parse refusals go to the context's streams.
 * A command is added with `.command()` on the program or on a group, never with `new Command()`
 * and `.addCommand()`, which drops these output and exit settings. An argument parser refuses a
 * value by throwing commander's `InvalidArgumentError` (a plain `Error` there is a software
 * failure). A command fails by throwing, and writes its result through `context.stdout` only once
 * it can no longer fail.
 */
export function createProgram(context: CommandContext): Command {
  return (
    new Command("sidekicks")
      .description("Drive AI Sidekicks sessions from the terminal.")
      .version(packageManifest.version)
      .helpCommand(true) // Commander adds `help` itself only once a command exists.
      // Reached only when no command matched, so it holds with or without commands registered: a
      // bare `sidekicks` refuses with its usage on stderr, and any other word is an unknown command.
      .usage("[options] [command]")
      .argument("[words...]")
      .action((words: string[], _options: unknown, program: Command) => {
        const [unknownWord] = words;
        if (unknownWord === undefined) {
          program.help({ error: true });
        }
        program.error(`error: unknown command '${unknownWord}'`, {
          code: "commander.unknownCommand",
        });
      })
      .exitOverride((commanderError) => {
        throw new PrintedCommanderExit(commanderError);
      })
      .configureOutput({
        writeOut: (text) => context.stdout.write(text),
        writeErr: (text) => context.stderr.write(text),
      })
  );
}

function writeFailure(program: Command, error: unknown): void {
  // Commander fills every output setting when it builds a command; only the getter's type marks
  // them optional.
  const { writeErr } = program.configureOutput() as Required<OutputConfiguration>;
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : inspect(error);
  writeErr(`error: ${message}\n`);
}

// The mapper throws for a daemon code with no exit code; that failure is reported like any other.
function exitCodeForRunFailure(program: Command, error: unknown): ExitCode {
  try {
    return exitCodeForFailure(error);
  } catch (mappingError) {
    writeFailure(program, mappingError);
    return LOCAL_FAILURE_EXIT_CODES.software;
  }
}

/**
 * Runs a program from {@link createProgram} over the arguments after the executable and script and
 * returns the exit code. The one error boundary: every failure is reported on the program's
 * configured stderr, never on stdout and never with a stack, and turned into an exit code.
 */
export async function runProgram(program: Command, args: readonly string[]): Promise<ExitCode> {
  try {
    await program.parseAsync(args, { from: "user" });
    return ExitCode.Success;
  } catch (error) {
    if (error instanceof PrintedCommanderExit) {
      return error.commanderError.exitCode === 0
        ? ExitCode.Success
        : exitCodeForRunFailure(program, error.commanderError);
    }
    writeFailure(program, error);
    return exitCodeForRunFailure(program, error);
  }
}
