// What a provider's permission ask is about, as its card draws it and a rule on it names it: the
// category, the target as free text, and the subject a standing rule names, derived here once so
// the card's button, the answer's check and the provider's rule all read the same words.
//
//   * A command's subject is its program and, where the word right after it reads as one, its
//     first subcommand (`npm run`, `git push`); git's own options are read past to its subcommand.
//     Only a line of one plain command has one: a rule over a line of several, over the string an
//     `sh -c` or `eval` runs, over a command run through another (`sudo`, `env`, `xargs`), or over
//     a git command whose options change what it runs, would answer commands the card never named.
//   * A force push or a branch delete, wherever the line runs it, is `destructive_git` and takes
//     no standing allow, and no rule in force answers it: it always reaches the card. So does an
//     ask the provider's own safety check flagged.
//   * A change to one file names its path, as does a read; a change to several files names none.
//   * A host names itself, a tool its name; a plan and input to a running command take no rule.

import { FILE_PATH_MAX_LEN } from "@ai-sidekicks/contracts/free-form-string";
import type { ApprovalCategory } from "@ai-sidekicks/contracts/approval";

import { readGitSubcommand, runsDestructiveGit } from "../policy/destructive-git.js";
import { readCommandString, readShellLine, type ShellCommand } from "../policy/shell-commands.js";
import type { ProviderAskAction, ProviderPermissionAsk } from "../provider/port/permission-ask.js";
import type { ApprovalResourceDescriptor } from "./request-create.js";

/** A provider ask as the approval service raises it. */
export interface ProviderAskDescription {
  readonly category: ApprovalCategory;
  readonly scope: string;
  readonly resourceDescriptor: ApprovalResourceDescriptor;
}

// A word that reads as a subcommand: lower-case letters, digits and dashes, never a path or a file.
const SUBCOMMAND_WORD = /^[a-z][a-z0-9-]*$/u;

/** Describes one ask the approval service raises for a person's answer. */
export function describeProviderAsk(ask: ProviderPermissionAsk): ProviderAskDescription {
  const { action } = ask;
  const category = categoryOf(action);
  const scope = boundedWireText(targetTextOf(action)) ?? ask.toolName;
  const derivedSubject = deriveRuleSubject(action);
  const subject = derivedSubject === undefined ? undefined : boundedWireText(derivedSubject);
  // A subject the wire bound had to change no longer says exactly what the rule would cover.
  const standingAllowOffered = mayAllowStand(ask) && subject === derivedSubject;
  return {
    category,
    scope,
    resourceDescriptor: {
      subject: subject ?? scope,
      standingAllowOffered,
      projectScopeOffered: standingAllowOffered && ask.ruleScopes.includes("project"),
      editable: isEditable(action),
      action,
      toolName: ask.toolName,
      ...(ask.prompt === undefined ? {} : { prompt: ask.prompt }),
    },
  };
}

/**
 * Whether a standing allow may stand on `ask`, made on its card or answering it while in force: the
 * provider keeps a rule on it, neither the daemon nor the provider's own safety check flagged it,
 * and it has a subject to name.
 */
export function mayAllowStand(ask: ProviderPermissionAsk): boolean {
  return (
    ask.ruleScopes.length > 0 &&
    !ask.isProviderFlagged &&
    categoryOf(ask.action) !== "destructive_git" &&
    deriveRuleSubject(ask.action) !== undefined
  );
}

/**
 * The subject a standing rule on `action` names, or `undefined` for an action no rule may name: a
 * plan, input to a running command, a change to several files, or a line that is no one plain
 * command.
 */
export function deriveRuleSubject(action: ProviderAskAction): string | undefined {
  switch (action.kind) {
    case "command": {
      const { commands, isWhole } = readShellLine(action.command);
      const [only, ...others] = commands;
      return isWhole && only !== undefined && others.length === 0
        ? commandSubjectOf(only)
        : undefined;
    }
    case "file_change":
      return action.paths.length === 1 ? action.paths[0] : undefined;
    case "file_read":
      return action.path;
    case "network":
      return action.host;
    case "tool":
      return action.toolName;
    case "command_input":
    case "plan":
      return undefined;
  }
}

function commandSubjectOf(command: ShellCommand): string | undefined {
  const { program, argumentWords, wrappers } = command;
  if (wrappers.length > 0 || readCommandString(command) !== undefined) {
    return undefined;
  }
  let next = argumentWords[0];
  if (program === "git") {
    const { subcommand, changesWhatRuns } = readGitSubcommand(argumentWords);
    if (changesWhatRuns) {
      return undefined;
    }
    next = subcommand;
  }
  return next !== undefined && SUBCOMMAND_WORD.test(next) ? `${program} ${next}` : program;
}

function categoryOf(action: ProviderAskAction): ApprovalCategory {
  switch (action.kind) {
    case "plan":
      return "plan_approval";
    case "command":
      return runsDestructiveGit(action.command) ? "destructive_git" : "tool_execution";
    case "file_change":
      return "file_write";
    case "network":
      return "network_access";
    case "command_input":
    case "file_read":
    case "tool":
      return "tool_execution";
  }
}

// The target the card names in a line: the command or input whole, the files one per line, the
// host or the tool; a plan has none of its own.
function targetTextOf(action: ProviderAskAction): string {
  switch (action.kind) {
    case "command":
      return action.command;
    case "command_input":
      return action.input;
    case "file_change":
      return action.paths.join("\n");
    case "file_read":
      return action.path;
    case "network":
      return action.host;
    case "tool":
      return action.toolName;
    case "plan":
      return "";
  }
}

// A command or a path may be corrected before it is approved; nothing else may.
function isEditable(action: ProviderAskAction): boolean {
  return (
    action.kind === "command" ||
    action.kind === "file_read" ||
    (action.kind === "file_change" && action.paths.length === 1)
  );
}

// `text` as the wire carries a scope or a subject: no NUL byte, cut to the bound on a whole
// character, and `undefined` where nothing but white space is left.
function boundedWireText(text: string): string | undefined {
  const characters = [...text.replaceAll("\0", "")];
  let bounded = "";
  for (const character of characters) {
    if (bounded.length + character.length > FILE_PATH_MAX_LEN) {
      break;
    }
    bounded += character;
  }
  return /\S/u.test(bounded) ? bounded : undefined;
}
