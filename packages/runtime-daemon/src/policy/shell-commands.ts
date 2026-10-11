// Reads a shell line into the simple commands it runs, each as its program and the words after it,
// for the daemon's own answers to a command ask and for the subject a rule on one names. The parser
// reads the line the way a POSIX shell would; nothing here guesses at what it could not read.

import { type Command, parse } from "unbash";

/**
 * One simple command: its program's own name, with any folder taken off, and the words after it.
 */
export interface ShellCommand {
  readonly program: string;
  readonly argumentWords: readonly string[];
}

/**
 * The simple commands of one line, nested ones included, in the order they appear; `isWhole` is
 * false when the parser could not read some of it, whose commands are then not among them.
 */
export interface ShellLineReading {
  readonly commands: readonly ShellCommand[];
  readonly isWhole: boolean;
}

// Words that run the command after them, so the program is the word that follows.
const COMMAND_PREFIXES: ReadonlySet<string> = new Set(["env", "exec", "command", "nohup", "time"]);
const VARIABLE_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;

// Shells whose `-c`, alone or in a cluster such as `-lc`, runs the first word after the options as
// a command line, and the options of theirs that take the next word as their value.
const COMMAND_STRING_SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "zsh"]);
const SHELL_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  "-o",
  "+o",
  "-O",
  "+O",
  "--rcfile",
  "--init-file",
]);

/**
 * Reads `line` into its simple commands, those in a pipeline, a chain or a substitution included.
 */
export function readShellLine(line: string): ShellLineReading {
  const script = parse(line);
  return {
    commands: simpleCommandsIn(script).flatMap((command) => {
      const read = readCommand(command);
      return read === undefined ? [] : [read];
    }),
    isWhole: !hasParseErrors(script),
  };
}

/**
 * The command line `command` hands a shell to run: the string an `eval` runs, or the one an `sh`,
 * `bash` or `zsh` runs with `-c` among its short options; `undefined` for any other command.
 */
export function readCommandString({ program, argumentWords }: ShellCommand): string | undefined {
  if (program === "eval") {
    return argumentWords.join(" ");
  }
  return COMMAND_STRING_SHELLS.has(program) ? shellCommandStringOf(argumentWords) : undefined;
}

// The command line a shell runs: with `-c` among its short options, the first word after the
// options; the words after it are the line's own `$0` and arguments.
function shellCommandStringOf(argumentWords: readonly string[]): string | undefined {
  let readsCommandString = false;
  for (let i = 0; i < argumentWords.length; i++) {
    const word = argumentWords[i] ?? "";
    if (word === "--" || word === "-") {
      return readsCommandString ? argumentWords[i + 1] : undefined;
    }
    if (SHELL_OPTIONS_WITH_VALUE.has(word)) {
      i++;
    } else if (/^[-+]./u.test(word)) {
      readsCommandString ||= !word.startsWith("--") && word.startsWith("-") && word.includes("c");
    } else {
      return readsCommandString ? word : undefined;
    }
  }
  return undefined;
}

// The program is the first word that is neither an assignment nor a prefix that runs the next
// word; a command of assignments alone runs none.
function readCommand(command: Command): ShellCommand | undefined {
  const words = [command.name, ...command.args].flatMap((argument) =>
    argument?.type === "Word" ? [argument.value] : [],
  );
  const programIndex = words.findIndex(
    (word) => !VARIABLE_ASSIGNMENT.test(word) && !COMMAND_PREFIXES.has(word),
  );
  if (programIndex === -1) {
    return undefined;
  }
  const program = words[programIndex] ?? "";
  return {
    program: program.slice(program.lastIndexOf("/") + 1),
    argumentWords: words.slice(programIndex + 1),
  };
}

// Whether the parser reported an error anywhere in the line: a substitution's body reports its own
// errors on its own script, never on the line's.
function hasParseErrors(node: unknown): boolean {
  if (Array.isArray(node)) {
    return node.some(hasParseErrors);
  }
  if (typeof node !== "object" || node === null) {
    return false;
  }
  const fields = ((node as { readonly toJSON?: () => object }).toJSON?.() ?? node) as {
    readonly errors?: unknown;
  };
  return (
    (Array.isArray(fields.errors) && fields.errors.length > 0) ||
    Object.values(fields).some(hasParseErrors)
  );
}

// Every simple command in the parsed line, nested ones included: those in a pipeline, a chain, a
// subshell or a loop, and those a substitution runs, inside double quotes, an assignment or a
// here-document too. The parser fills most fields lazily through getters a plain walk never reads,
// and each such node's `toJSON` returns all of them, so the walk reads a node's fields through it.
function simpleCommandsIn(node: unknown, found: Command[] = []): Command[] {
  if (Array.isArray(node)) {
    for (const child of node) {
      simpleCommandsIn(child, found);
    }
  } else if (typeof node === "object" && node !== null) {
    const syntaxNode = node as { readonly type?: unknown; readonly toJSON?: () => object };
    if (syntaxNode.type === "Command") {
      found.push(node as Command);
    }
    for (const child of Object.values(syntaxNode.toJSON?.() ?? node)) {
      simpleCommandsIn(child, found);
    }
  }
  return found;
}
