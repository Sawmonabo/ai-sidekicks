// The few provider asks the daemon answers itself, with no rule evaluation and no card: it refuses
// an agent's `claude agents`, `claude daemon` and `claude --bg`, whose work would run outside the
// session's agents, outside Stop and Interrupt and off its receipt. It reads the line and, nested
// to any depth, the string an `sh -c`, `bash -c`, `zsh -c` or `eval` runs; a string the parser
// cannot read goes to the person. It allows an agent's own read or change of a `.md` note in the
// agent-memory folder, as Claude Code allows its own memory folder unasked. Every other ask, a removal a provider's own safety check flags among them, is
// left for the person's card. Neither answer depends on the session's level: the refusal holds at
// every level, and the memory asks arrive only at the levels that ask.

import path from "node:path";

import { type Command, parse } from "unbash";

import { canonicalFolderPath } from "../workspace/folder/canonical-path.js";
import { isContainedWithin } from "../workspace/trust-envelope.js";

/**
 * A provider's ask as the designed answers read it: a command an agent would run, or an agent's
 * `Read`, `Write` or `Edit` of one file, named by the path the provider sent.
 *
 * @consumedBy the permission-ask normalizer, which turns each provider ask into one
 */
export type ProviderAsk =
  | { readonly kind: "command"; readonly command: string }
  | { readonly kind: "file"; readonly path: string };

/**
 * The daemon's own answer to an ask; a refusal carries the reason the agent reads.
 *
 * @consumedBy the permission check, which reports an allow as a policy allow and a refusal as denied
 */
export type ProviderAskAnswer =
  | { readonly decision: "allow" }
  | { readonly decision: "deny"; readonly reason: string };

// What the agent reads when its background Claude Code command is refused.
const BACKGROUND_CLAUDE_REFUSAL =
  "`claude agents`, `claude daemon` and `claude --bg` are refused inside this session: their work " +
  "would run outside the session's agents, outside Stop and Interrupt, and off its receipt.";

// The subcommands of `claude` whose work outlives the call, and the flag, under both its names,
// that backgrounds a prompt.
const BACKGROUND_SUBCOMMANDS: ReadonlySet<string> = new Set(["agents", "daemon"]);
const BACKGROUND_FLAGS: readonly string[] = ["--bg", "--background"];

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

const AGENT_NOTE_EXTENSION = ".md";

/**
 * The daemon's designed answer to `ask`, or `undefined` when it has none and the ask goes to the
 * person. `agentMemoryFolder` is the one all-projects agent-memory folder; a file is in it when its
 * path, with every link resolved, lies beneath that folder's, so a configuration home's link to the
 * folder counts and a link out of it does not. Rejects when a path cannot be resolved for a reason
 * other than its absence.
 */
export async function answerProviderAsk(
  ask: ProviderAsk,
  agentMemoryFolder: string,
): Promise<ProviderAskAnswer | undefined> {
  if (ask.kind === "command") {
    return startsBackgroundClaude(ask.command)
      ? { decision: "deny", reason: BACKGROUND_CLAUDE_REFUSAL }
      : undefined;
  }
  return (await isAgentNote(ask.path, agentMemoryFolder)) ? { decision: "allow" } : undefined;
}

// A line the parser cannot fully read still yields the commands it could read, and those are
// judged; whatever it could not read goes to the person with the rest of the ask.
function startsBackgroundClaude(command: string): boolean {
  return simpleCommandsIn(parse(command)).some(runsBackgroundClaude);
}

// A string a shell's `-c` or `eval` runs is judged only when the parser reads all of it, its
// substitutions included, so a string it cannot read goes to the person rather than to a guess.
function runsBackgroundClaudeInString(command: string): boolean {
  const script = parse(command);
  return !hasParseErrors(script) && simpleCommandsIn(script).some(runsBackgroundClaude);
}

function runsBackgroundClaude(simpleCommand: Command): boolean {
  const words = [simpleCommand.name, ...simpleCommand.args].flatMap((argument) =>
    argument?.type === "Word" ? [argument.value] : [],
  );
  const programIndex = words.findIndex(
    (word) => !VARIABLE_ASSIGNMENT.test(word) && !COMMAND_PREFIXES.has(word),
  );
  if (programIndex === -1) {
    return false;
  }
  const program = programNameOf(words[programIndex] ?? "");
  const argumentWords = words.slice(programIndex + 1);
  if (program === "eval") {
    return runsBackgroundClaudeInString(argumentWords.join(" "));
  }
  if (COMMAND_STRING_SHELLS.has(program)) {
    const commandString = shellCommandStringOf(argumentWords);
    return commandString !== undefined && runsBackgroundClaudeInString(commandString);
  }
  return (
    program === "claude" &&
    (namesBackgroundSubcommand(argumentWords) ||
      argumentWords.some((word) =>
        BACKGROUND_FLAGS.some((flag) => word === flag || word.startsWith(`${flag}=`)),
      ))
  );
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

// The subcommand is the first word that is no option. A word right after an option may be that
// option's value or the subcommand, so it is refused when it names one and skipped otherwise; any
// other word is the prompt, and no word after it is a subcommand.
function namesBackgroundSubcommand(argumentWords: readonly string[]): boolean {
  let mayBeOptionValue = false;
  for (const word of argumentWords) {
    if (word === "--") {
      mayBeOptionValue = false;
    } else if (word.startsWith("-")) {
      mayBeOptionValue = !word.includes("=");
    } else if (BACKGROUND_SUBCOMMANDS.has(word)) {
      return true;
    } else if (mayBeOptionValue) {
      mayBeOptionValue = false;
    } else {
      return false;
    }
  }
  return false;
}

function programNameOf(word: string): string {
  return word.slice(word.lastIndexOf("/") + 1);
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

// Only an absolute path with no `.` or `..` part is judged: a `..` after a link resolves against the
// link's target, which a path joined on the folder's side would not see.
async function isAgentNote(filePath: string, agentMemoryFolder: string): Promise<boolean> {
  if (
    !path.isAbsolute(filePath) ||
    path.normalize(filePath) !== filePath ||
    path.extname(filePath) !== AGENT_NOTE_EXTENSION
  ) {
    return false;
  }
  const [fileKey, folderKey] = await Promise.all([
    canonicalFolderPath(filePath),
    canonicalFolderPath(agentMemoryFolder),
  ]);
  return isContainedWithin(fileKey.split(path.sep), folderKey.split(path.sep));
}
