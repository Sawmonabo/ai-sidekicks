// Reads a shell line into the simple commands it runs, each as its program and the words after it,
// past the programs that run the command after their own options, such as `env -i`, `sudo -u` or
// `timeout 5`, for the daemon's own answers to a command ask and for the subject a rule on one
// names; takes the line a shell is handed off a `<shell> -lc '…'` wrapper; and joins words back
// into a line. The parser reads the line the way a POSIX shell would; nothing here guesses at what
// it could not read.

import { type Command, parse } from "unbash";

import { quoteForPosixShell } from "../shell-quoting.js";

/**
 * One simple command: its program's own name, with any folder taken off, the words after it, and
 * the programs it was run through, such as `sudo` or `env`, outermost first.
 */
export interface ShellCommand {
  readonly program: string;
  readonly argumentWords: readonly string[];
  readonly wrappers: readonly string[];
}

/**
 * The simple commands of one line, nested ones included, in the order they appear; `isWhole` is
 * false when the parser could not read some of it, whose commands are then not among them.
 */
export interface ShellLineReading {
  readonly commands: readonly ShellCommand[];
  readonly isWhole: boolean;
}

// How a program that runs the command after it reads its own words first: its options that take
// the next word as their value, and the plain words it takes before the command.
interface CommandWrapper {
  readonly optionsWithValue: ReadonlySet<string>;
  readonly leadingOperands: number;
}

// The programs that run the command after them, so the program is the word past their own.
const COMMAND_WRAPPERS: ReadonlyMap<string, CommandWrapper> = new Map([
  ["env", { optionsWithValue: new Set(["-u", "--unset", "-C", "--chdir"]), leadingOperands: 0 }],
  ["exec", { optionsWithValue: new Set(["-a"]), leadingOperands: 0 }],
  ["command", { optionsWithValue: new Set(), leadingOperands: 0 }],
  ["nohup", { optionsWithValue: new Set(), leadingOperands: 0 }],
  ["time", { optionsWithValue: new Set(["-o", "--output", "-f", "--format"]), leadingOperands: 0 }],
  // The duration comes before the command.
  [
    "timeout",
    { optionsWithValue: new Set(["-s", "--signal", "-k", "--kill-after"]), leadingOperands: 1 },
  ],
  ["nice", { optionsWithValue: new Set(["-n", "--adjustment"]), leadingOperands: 0 }],
  [
    "sudo",
    {
      optionsWithValue: new Set([
        "-u",
        "--user",
        "-g",
        "--group",
        "-h",
        "--host",
        "-p",
        "--prompt",
        "-C",
        "--close-from",
        "-D",
        "--chdir",
        "-r",
        "--role",
        "-t",
        "--type",
        "-T",
        "--command-timeout",
        "-U",
        "--other-user",
        "-R",
        "--chroot",
      ]),
      leadingOperands: 0,
    },
  ],
  [
    "xargs",
    {
      optionsWithValue: new Set([
        "-I",
        "-L",
        "-n",
        "--max-args",
        "-P",
        "--max-procs",
        "-s",
        "--max-chars",
        "-d",
        "--delimiter",
        "-E",
        "-a",
        "--arg-file",
      ]),
      leadingOperands: 0,
    },
  ],
]);

// `env -S` splits its value into the words the command starts with.
const ENV_SPLIT_STRING_OPTIONS: ReadonlySet<string> = new Set(["-S", "--split-string"]);

const VARIABLE_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;

// A word a shell reads as itself, which needs no quoting.
const PLAIN_SHELL_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/u;

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

/**
 * The command line `line` runs when it is one command handing a shell its whole line to run, as
 * Codex wraps a command in `/bin/zsh -lc '…'`; any other line is returned as it is.
 */
export function unwrapShellCommandLine(line: string): string {
  const { commands, isWhole } = readShellLine(line);
  const [only, ...others] = commands;
  if (!isWhole || only === undefined || others.length > 0 || only.wrappers.length > 0) {
    return line;
  }
  return readCommandString(only) ?? line;
}

/** `words` as one shell line, each word quoted only where a shell would read it otherwise. */
export function joinShellWords(words: readonly string[]): string {
  return words
    .map((word) => (PLAIN_SHELL_WORD.test(word) ? word : quoteForPosixShell(word)))
    .join(" ");
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

// The program is the first word that is neither an assignment nor a wrapper that runs the command
// after its own options and operands; a command of assignments alone runs none.
function readCommand(command: Command): ShellCommand | undefined {
  let words = [command.name, ...command.args].flatMap((argument) =>
    argument?.type === "Word" ? [argument.value] : [],
  );
  const wrappers: string[] = [];
  for (;;) {
    while (words[0] !== undefined && VARIABLE_ASSIGNMENT.test(words[0])) {
      words = words.slice(1);
    }
    const first = words[0];
    if (first === undefined) {
      return undefined;
    }
    const program = first.slice(first.lastIndexOf("/") + 1);
    const wrapper = COMMAND_WRAPPERS.get(program);
    if (wrapper === undefined) {
      return { program, argumentWords: words.slice(1), wrappers };
    }
    wrappers.push(program);
    words = wrappedWordsOf(program, wrapper, words.slice(1));
  }
}

// The words a wrapper runs: past its options, an option's value and its leading operands.
function wrappedWordsOf(
  program: string,
  wrapper: CommandWrapper,
  words: readonly string[],
): string[] {
  let i = 0;
  while (i < words.length) {
    const word = words[i] ?? "";
    if (word === "--") {
      i++;
      break;
    }
    if (!word.startsWith("-") || word === "-") {
      break;
    }
    if (program === "env" && ENV_SPLIT_STRING_OPTIONS.has(word)) {
      return [
        ...(words[i + 1] ?? "").split(/\s+/u).filter((part) => part !== ""),
        ...words.slice(i + 2),
      ];
    }
    i += wrapper.optionsWithValue.has(word) ? 2 : 1;
  }
  return words.slice(Math.min(i + wrapper.leadingOperands, words.length));
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
