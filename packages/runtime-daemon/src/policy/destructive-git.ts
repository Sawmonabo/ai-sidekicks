// Which git commands are destructive, a force push or a branch delete, read wherever a line runs
// them, the strings its shells run included; the subcommand a git command runs, past git's own
// options; and which standing rules a provider keeps as a prefix that would also let a destructive
// one through, which no provider can narrow and so is never handed to one.

import type { ProviderAskRule } from "../provider/port/permission-ask.js";
import { readCommandString, readShellLine, type ShellCommand } from "./shell-commands.js";

/** The subcommand a git command runs, and whether its options change what git itself runs. */
export interface GitSubcommandReading {
  readonly subcommand: string | undefined;
  /**
   * Whether an option before the subcommand sets configuration or the folder git's own programs
   * come from (`-c`, `--config-env`, `--exec-path`), which can make any subcommand run anything.
   */
  readonly changesWhatRuns: boolean;
}

// The options before git's subcommand that take the next word as their value.
const GIT_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--config-env",
  "--attr-source",
]);

// The options before git's subcommand that can change what it runs, alone or with `=<value>`.
const GIT_OPTIONS_CHANGING_WHAT_RUNS: readonly string[] = ["-c", "--config-env", "--exec-path"];

// The subcommands that can push with force, delete a remote branch or delete a local one.
const DESTRUCTIVE_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set(["push", "branch"]);

// A short-option cluster of `git push` that forces (`f`) or deletes (`d`), and of `git branch` that
// deletes (`d`, `D`).
const PUSH_DESTRUCTIVE_CLUSTER = /^-[a-zA-Z]*[fd][a-zA-Z]*$/u;
const BRANCH_DELETE_CLUSTER = /^-[a-zA-Z]*[dD][a-zA-Z]*$/u;
const PUSH_DESTRUCTIVE_OPTIONS: readonly string[] = [
  "--force",
  "--force-with-lease",
  "--force-if-includes",
  "--delete",
  "--mirror",
  "--prune",
];

/** Whether `line` runs a force push or a branch delete anywhere, its shells' strings included. */
export function runsDestructiveGit(line: string): boolean {
  return readShellLine(line).commands.some((command) => {
    const commandString = readCommandString(command);
    return commandString === undefined
      ? isDestructiveGit(command)
      : runsDestructiveGit(commandString);
  });
}

/** The subcommand of a git command with `argumentWords`, the first word past git's own options. */
export function readGitSubcommand(argumentWords: readonly string[]): GitSubcommandReading {
  const index = gitSubcommandIndexOf(argumentWords);
  return {
    subcommand: argumentWords[index],
    changesWhatRuns: argumentWords
      .slice(0, index)
      .some((word) =>
        GIT_OPTIONS_CHANGING_WHAT_RUNS.some(
          (option) => word === option || word.startsWith(`${option}=`),
        ),
      ),
  };
}

/**
 * Whether a provider keeping `rule` as a prefix over its subject's words would also let a force
 * push or a branch delete through: a command allow on `git` alone, `git push` or `git branch`.
 * Such a rule is the daemon's alone, which answers each ask it covers and sends a destructive one
 * to the card.
 */
export function coversDestructiveGit(rule: ProviderAskRule): boolean {
  if (rule.action !== "command" || rule.sense !== "allow") {
    return false;
  }
  const [program, subcommand, ...rest] = rule.subject.split(" ");
  return (
    program === "git" &&
    rest.length === 0 &&
    (subcommand === undefined || DESTRUCTIVE_GIT_SUBCOMMANDS.has(subcommand))
  );
}

// A push that forces or deletes, or a branch delete.
function isDestructiveGit({ program, argumentWords }: ShellCommand): boolean {
  if (program !== "git") {
    return false;
  }
  const subcommandIndex = gitSubcommandIndexOf(argumentWords);
  const subcommand = argumentWords[subcommandIndex];
  const rest = argumentWords.slice(subcommandIndex + 1);
  if (subcommand === "push") {
    return rest.some(
      (word) =>
        PUSH_DESTRUCTIVE_CLUSTER.test(word) ||
        PUSH_DESTRUCTIVE_OPTIONS.some(
          (option) => word === option || word.startsWith(`${option}=`),
        ) ||
        // A refspec that forces (`+main`) or deletes (`:main`) the branch it names.
        word.startsWith("+") ||
        word.startsWith(":"),
    );
  }
  if (subcommand === "branch") {
    return rest.some((word) => word === "--delete" || BRANCH_DELETE_CLUSTER.test(word));
  }
  return false;
}

// The subcommand is the first word that is no option, past the value of an option that takes one.
function gitSubcommandIndexOf(argumentWords: readonly string[]): number {
  for (let i = 0; i < argumentWords.length; i++) {
    const word = argumentWords[i] ?? "";
    if (GIT_OPTIONS_WITH_VALUE.has(word)) {
      i++;
    } else if (!word.startsWith("-")) {
      return i;
    }
  }
  return argumentWords.length;
}
