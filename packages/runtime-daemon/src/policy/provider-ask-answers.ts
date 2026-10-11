// The few provider asks the daemon answers itself, with no rule evaluation and no card: it refuses
// an agent's `claude agents`, `claude daemon` and `claude --bg`, whose work would run outside the
// session's agents, outside Stop and Interrupt and off its receipt. It reads the line and, nested
// to any depth, the string an `sh -c`, `bash -c`, `zsh -c` or `eval` runs; a string the parser
// cannot read goes to the person. The same reading refuses such a command at the drivers' pre-tool
// hooks, at the levels that never ask. It allows an agent's own read or change of a `.md` note in
// the agent-memory folder, as Claude Code allows its own memory folder unasked. Every other ask, a
// removal a provider's own safety check flags among them, is left for the person's card. Neither
// answer depends on the session's level: the refusal holds at every level, and the memory asks
// arrive only at the levels that ask.

import path from "node:path";

import type { PathRules } from "../path-rules/contract.js";
import type { ProviderAskAction } from "../provider/port/permission-ask.js";
import { canonicalFolderPath } from "../workspace/folder/canonical-path.js";
import { isContainedWithin } from "../workspace/trust-envelope.js";
import { readCommandString, readShellLine, type ShellCommand } from "./shell-commands.js";

/** The daemon's own answer to an ask; a refusal carries the reason the agent reads. */
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

/**
 * The words a refused background command starts with when written plainly, which a provider's own
 * prefix rules can name; {@link refuseBackgroundClaude} reads every other way of writing one.
 */
export const BACKGROUND_CLAUDE_COMMAND_PREFIXES: readonly string[] = [
  ...BACKGROUND_SUBCOMMANDS,
  ...BACKGROUND_FLAGS,
].map((word) => `claude ${word}`);

const AGENT_NOTE_EXTENSION = ".md";

/**
 * The daemon's designed answer to an ask for `action`, or `undefined` when it has none and the ask
 * goes to the person. `agentMemoryFolder` is the one all-projects agent-memory folder; a file is in
 * it when its path, with every link resolved, lies beneath that folder's, so a configuration home's
 * link to the folder counts and a link out of it does not, and a change is allowed only when every
 * file it touches is such a note, the paths compared by the system's `pathRules`. Rejects when a
 * path cannot be resolved for a reason other than its absence.
 */
export async function answerProviderAsk(
  action: ProviderAskAction,
  agentMemoryFolder: string,
  pathRules: PathRules,
): Promise<ProviderAskAnswer | undefined> {
  if (action.kind === "command") {
    const reason = refuseBackgroundClaude(action.command);
    return reason === undefined ? undefined : { decision: "deny", reason };
  }
  const paths =
    action.kind === "file_change" ? action.paths : action.kind === "file_read" ? [action.path] : [];
  if (paths.length === 0) {
    return undefined;
  }
  const areNotes = await Promise.all(
    paths.map((filePath) => isAgentNote(filePath, agentMemoryFolder, pathRules)),
  );
  return areNotes.every(Boolean) ? { decision: "allow" } : undefined;
}

/**
 * The reason the agent reads when `command` would start `claude agents`, `claude daemon` or
 * `claude --bg`, read through `sh -c`, `bash -c`, `zsh -c` and `eval` to any depth, or `undefined`
 * for any other command. A pre-tool hook refuses with it at the levels that never ask.
 */
export function refuseBackgroundClaude(command: string): string | undefined {
  return startsBackgroundClaude(command) ? BACKGROUND_CLAUDE_REFUSAL : undefined;
}

// A line the parser cannot fully read still yields the commands it could read, and those are
// judged; whatever it could not read goes to the person with the rest of the ask.
function startsBackgroundClaude(command: string): boolean {
  return readShellLine(command).commands.some(runsBackgroundClaude);
}

// A string a shell's `-c` or `eval` runs is judged only when the parser reads all of it, its
// substitutions included, so a string it cannot read goes to the person rather than to a guess.
function runsBackgroundClaudeInString(command: string): boolean {
  const reading = readShellLine(command);
  return reading.isWhole && reading.commands.some(runsBackgroundClaude);
}

function runsBackgroundClaude(command: ShellCommand): boolean {
  const commandString = readCommandString(command);
  if (commandString !== undefined) {
    return runsBackgroundClaudeInString(commandString);
  }
  const { program, argumentWords } = command;
  return (
    program === "claude" &&
    (namesBackgroundSubcommand(argumentWords) ||
      argumentWords.some((word) =>
        BACKGROUND_FLAGS.some((flag) => word === flag || word.startsWith(`${flag}=`)),
      ))
  );
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

// Only an absolute path with no `.` or `..` part is judged: a `..` after a link resolves against
// the link's target, which a path joined on the folder's side would not see.
async function isAgentNote(
  filePath: string,
  agentMemoryFolder: string,
  pathRules: PathRules,
): Promise<boolean> {
  if (
    !path.isAbsolute(filePath) ||
    path.normalize(filePath) !== filePath ||
    path.extname(filePath) !== AGENT_NOTE_EXTENSION
  ) {
    return false;
  }
  const [fileKey, folderKey] = await Promise.all([
    canonicalFolderPath(filePath, pathRules),
    canonicalFolderPath(agentMemoryFolder, pathRules),
  ]);
  return isContainedWithin(fileKey.split(pathRules.sep), folderKey.split(pathRules.sep));
}
