// The one code-to-words mapper: an error, refusal or event code, a status, and the reason a code
// carries, read as words in sentence case, so no wire spelling reaches the screen. A code with a
// label reads as that label; every other code reads as its own words, a root with a screen word
// of its own reading as that word.
//
// Only a code the other side registered reads as words above a refusal's message. Registered
// codes are wire names, two to four lowerCamelCase segments joined by dots (`mcp.server.notFound`),
// a segment's words sometimes joined by `_`; the app's own codes are kebab-case, and a
// refusal the app wrote reads as its sentence alone, never as the name of what failed.

import { CONNECTION_UNAVAILABLE_CODE } from "@ai-sidekicks/contracts/jsonrpc/message";
import { PROVIDER_ACCOUNT_NOT_AUTHENTICATED_CODE } from "@ai-sidekicks/contracts/provider/account/methods";
import { PROJECT_CLONE_REFUSED_CODE } from "@ai-sidekicks/contracts/repo/clone";
import {
  WORKFLOW_SANDBOX_UNAVAILABLE_CODE,
  WORKFLOW_STEP_THREAD_FAILED_CODE,
  WORKFLOW_STEP_TIMED_OUT_CODE,
} from "@ai-sidekicks/contracts/workflow/run/failures";

import { readFrozenRecord } from "./frozen-record.js";

/** Each code root whose screen word differs from its wire spelling, cased as a line starts it. */
const ROOT_WORDS: Readonly<Record<string, string>> = {
  agent: "Sidekick",
  attention: "Notification",
  daemon: "Background service",
  mcp: "MCP",
};

/** The codes that read as their own label rather than as their words. */
const CODE_LABELS: Readonly<Record<string, string>> = {
  [WORKFLOW_STEP_TIMED_OUT_CODE]: "Step timed out",
  [WORKFLOW_SANDBOX_UNAVAILABLE_CODE]: "Sandbox unavailable",
  [WORKFLOW_STEP_THREAD_FAILED_CODE]: "Step thread failed",
  [CONNECTION_UNAVAILABLE_CODE]: "Connection lost",
  [PROVIDER_ACCOUNT_NOT_AUTHENTICATED_CODE]: "Login expired",
  // Cloning and resolving a folder's root are about the git repository, not the project.
  [PROJECT_CLONE_REFUSED_CODE]: "Repository clone refused",
  "repoMount.rootResolutionFailed": "Repository root resolution failed",
};

/** The form the error contract registers a code in: a wire name, words joined by case or `_`. */
const REGISTERED_CODE_FORM = /^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*(?:_[a-z0-9]+)*){1,3}$/;

/**
 * A code, status or kind and its listed reason as one line of words, the code first and the
 * reason after a middle dot: `agent.childRun.controlRefused` with `childEnded` reads
 * `Sidekick child run control refused · Child ended`, and `retired` reads `Retired`.
 */
export function codeWords(code: string, reason?: string): string {
  const words = wordsOf(code);
  return reason === undefined || reason.length === 0 ? words : `${words} · ${wordsOf(reason)}`;
}

/**
 * The words line above a refusal's message: the code and reason as words for a code the other
 * side registered, and `undefined` for one the app wrote, whose sentence stands alone.
 */
export function refusalWords(code: string, reason?: string): string | undefined {
  return REGISTERED_CODE_FORM.test(code) ? codeWords(code, reason) : undefined;
}

/**
 * A refusal card or banner read out as it is drawn: the words line, then the message, or the
 * message alone where the app wrote the refusal.
 */
export function refusalSentence(code: string, reason: string | undefined, message: string): string {
  const words = refusalWords(code, reason);
  return words === undefined ? message : `${words}. ${message}`;
}

// Its label, or its words split at `.`, `_` and `-` and where a lowercase letter or digit meets a
// capital (`startFailed` reads `Start failed`, and a run of capitals stays one word): a root before
// a `.` reads as its screen word, cased as written, and every other word in lower case, the line's
// first letter capitalized.
function wordsOf(code: string): string {
  const label = readFrozenRecord(CODE_LABELS, code);
  if (label !== undefined) {
    return label;
  }
  const dot = code.indexOf(".");
  const rootWord = dot === -1 ? undefined : readFrozenRecord(ROOT_WORDS, code.slice(0, dot));
  const rest = rootWord === undefined ? code : code.slice(dot + 1);
  const words = [
    ...(rootWord === undefined ? [] : [rootWord]),
    ...rest
      .split(/[._-]|(?<=[a-z0-9])(?=[A-Z])/)
      .filter((word) => word.length > 0)
      .map((word) => word.toLowerCase()),
  ].join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
