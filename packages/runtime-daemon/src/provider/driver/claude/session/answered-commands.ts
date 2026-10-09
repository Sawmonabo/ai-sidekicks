// The commands a person types that the daemon answers itself on Claude Code and never sends:
// Claude Code's own `/output-style` writes the project's local settings, its `/advisor` saves the
// choice for the whole machine, and its `/config` writes the person's settings, so each is applied
// for this one session instead. Only the `/config` keys a console control owns are the daemon's;
// every other `/config` goes as typed. Typed with nothing, `/output-style` and `/advisor` list what
// a control-only process in the session's folder printed for each; an argument the session cannot
// take goes as typed, and Claude Code answers it.

import { isPlainObject, readNonEmptyString } from "../../../record-readers.js";
import type { ClaudeCreationFiguresReading } from "./transport.js";

// The `/config` keys a console control owns, as Claude Code's parser names them, matched as it
// matches them, ignoring case.
const CLAUDE_CONSOLE_OWNED_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "model",
  "permissionmode",
  "autocompact",
]);

// The words that turn the advisor off, as Claude Code's own `/advisor` reads them.
const CLAUDE_ADVISOR_OFF_WORDS: ReadonlySet<string> = new Set(["off", "unset"]);

// The line Claude Code's `/advisor` prints its choices on, the last of them `off`.
const CLAUDE_ADVISOR_USAGE = /^Usage: \/advisor <(?<choices>[^>]*)>$/mu;

// The outcome Claude Code stamps on a command this session cannot open, which for `/advisor` means
// it offers no advisor here.
const CLAUDE_UNAVAILABLE_HEADLESS_OUTCOME = "unavailable_headless";

// The words Claude Code's own commands read as asking what the session holds, not as a value.
const CLAUDE_SHOW_WORDS: ReadonlySet<string> = new Set([
  "list",
  "show",
  "display",
  "current",
  "view",
  "get",
  "check",
  "describe",
  "print",
  "version",
  "about",
  "status",
  "?",
  "help",
  "-h",
  "--help",
]);

/** The descriptions Claude Code printed for its output styles, by name, or why it printed none. */
export type ClaudeOutputStyleDescriptions =
  | { readonly kind: "listed"; readonly descriptions: ReadonlyMap<string, string> }
  | { readonly kind: "unlisted"; readonly line: string };

/**
 * The advisors Claude Code's `/advisor` offers; or that it offers none here, with the line it
 * printed, shown as sent; or that they could not be listed, with why.
 */
export type ClaudeAdvisorChoices =
  | { readonly kind: "listed"; readonly choices: readonly string[] }
  | { readonly kind: "unoffered"; readonly line: string }
  | { readonly kind: "unlisted"; readonly line: string };

/** What a session holds for the commands the daemon answers itself with no argument. */
export interface ClaudeCommandChoices {
  readonly outputStyles: ClaudeOutputStyleDescriptions;
  readonly advisor: ClaudeAdvisorChoices;
}

/**
 * The advisor Claude Code says it will attach to the session's requests (`get_settings`
 * `applied.advisor`): a model, none, or unreported by a build whose reply carries no such field.
 */
export type ClaudeAttachedAdvisor =
  | { readonly kind: "attached"; readonly model: string }
  | { readonly kind: "none" }
  | { readonly kind: "unreported" };

/** Reads the advisor a `get_settings` reply says will attach to the session's requests. */
export function readClaudeAttachedAdvisor(
  reply: Record<string, unknown> | undefined,
): ClaudeAttachedAdvisor {
  const applied = reply?.["applied"];
  if (!isPlainObject(applied) || !("advisor" in applied)) {
    return { kind: "unreported" };
  }
  const model = readNonEmptyString(applied, "advisor");
  return model === undefined ? { kind: "none" } : { kind: "attached", model };
}

// Each style's description from what `/output-style` printed, one `- <name>[ (current)][:
// <description>]` row per style, matched on the longest of `names` a row starts with, so a colon
// inside a name or a description never moves the split. A row naming no known style is skipped.
function readClaudeOutputStyleDescriptions(
  text: string,
  names: readonly string[],
): ReadonlyMap<string, string> {
  const longestFirst = [...names].sort((first, second) => second.length - first.length);
  const descriptions = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (!line.startsWith("- ")) {
      continue;
    }
    const row = line.slice(2);
    for (const name of longestFirst) {
      if (!row.startsWith(name)) {
        continue;
      }
      const afterName = row.slice(name.length);
      const afterMark = afterName.startsWith(" (current)")
        ? afterName.slice(" (current)".length)
        : afterName;
      if (afterMark === "") {
        break;
      }
      if (afterMark.startsWith(": ")) {
        descriptions.set(name, afterMark.slice(2));
        break;
      }
    }
  }
  return descriptions;
}

// The advisors from `/advisor`'s usage line. Without one, an `unavailable_headless` reply means
// Claude Code offers no advisor here; any other reply from a build that stopped listing the command
// is a version fault.
function readClaudeAdvisorChoices(
  advisor: ClaudeCreationFiguresReading["advisor"],
): ClaudeAdvisorChoices {
  const offered =
    advisor.text === undefined
      ? undefined
      : CLAUDE_ADVISOR_USAGE.exec(advisor.text)?.groups?.["choices"];
  if (offered !== undefined) {
    return {
      kind: "listed",
      choices: offered.split("|").filter((choice) => !CLAUDE_ADVISOR_OFF_WORDS.has(choice)),
    };
  }
  if (advisor.outcome === CLAUDE_UNAVAILABLE_HEADLESS_OUTCOME && advisor.text !== undefined) {
    return { kind: "unoffered", line: advisor.text };
  }
  return {
    kind: "unlisted",
    line: advisor.isListed
      ? "Claude Code printed no advisor choices."
      : "This Claude Code build does not list its advisors.",
  };
}

/**
 * What a session holds from the command replies of its creation-time process: the style
 * descriptions, unlisted when the build no longer lists `/output-style`, and the advisors.
 */
export function readClaudeCommandChoices(
  reading: Pick<ClaudeCreationFiguresReading, "outputStyleNames" | "outputStyle" | "advisor">,
): ClaudeCommandChoices {
  const { outputStyle } = reading;
  const outputStyles: ClaudeOutputStyleDescriptions = !outputStyle.isListed
    ? { kind: "unlisted", line: "This Claude Code build does not list style descriptions." }
    : outputStyle.text === undefined
      ? { kind: "unlisted", line: "Claude Code printed no style descriptions." }
      : {
          kind: "listed",
          descriptions: readClaudeOutputStyleDescriptions(
            outputStyle.text,
            reading.outputStyleNames,
          ),
        };
  return { outputStyles, advisor: readClaudeAdvisorChoices(reading.advisor) };
}

/** What a session holds when its command choices could not be read, with the reason given. */
export function unreadableClaudeCommandChoices(detail: string): ClaudeCommandChoices {
  return {
    outputStyles: {
      kind: "unlisted",
      line: `Claude Code's style descriptions could not be read: ${detail}`,
    },
    advisor: { kind: "unlisted", line: `Claude Code's advisors could not be read: ${detail}` },
  };
}

/** One command the daemon answers itself, with the words typed after it, trimmed. */
type ClaudeAnsweredCommand =
  | { readonly name: "output-style" | "advisor"; readonly argument: string }
  | { readonly name: "config" };

/**
 * The command typed text is when the daemon answers it itself, or `undefined` for text that goes to
 * Claude Code as typed. Only text that starts with the command reads as one, as Claude Code reads
 * it.
 */
export function readClaudeAnsweredCommand(text: string): ClaudeAnsweredCommand | undefined {
  if (!text.startsWith("/")) {
    return undefined;
  }
  const [word = "", ...words] = text.slice(1).trim().split(/\s+/);
  switch (word) {
    case "output-style":
    case "advisor":
      return { name: word, argument: words.join(" ") };
    case "config": {
      // `key=value` pairs; a `/config` naming none of the owned keys goes as typed.
      const isOwned = words.some((pair) =>
        CLAUDE_CONSOLE_OWNED_CONFIG_KEYS.has((pair.split("=", 1)[0] ?? "").toLowerCase()),
      );
      return isOwned ? { name: "config" } : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * What a command comes to: a listing to show or a value to apply. It is never sent as typed, since
 * Claude Code's own command would save the choice beyond the session.
 */
export type ClaudeCommandOutcome<Value> =
  | { readonly kind: "listing"; readonly line: string }
  | { readonly kind: "apply"; readonly value: Value };

/**
 * What `/output-style <argument>` does on a session offering `styles` with `current` in force: a
 * style named in any case applies by its own name; anything else, nothing or a word asking to show
 * included, is the listing laid out as Claude Code's own with the descriptions it printed.
 */
export function answerClaudeOutputStyle(
  argument: string,
  styles: readonly string[],
  current: string | undefined,
  descriptions: ClaudeOutputStyleDescriptions,
): ClaudeCommandOutcome<string> {
  const requested = argument.toLowerCase();
  // A word asking what the session holds lists it, as Claude Code's own command reads it.
  const style = CLAUDE_SHOW_WORDS.has(requested)
    ? undefined
    : styles.find((name) => name.toLowerCase() === requested);
  if (style !== undefined) {
    return { kind: "apply", value: style };
  }
  const listed = styles.map((name) => {
    const description =
      descriptions.kind === "listed" ? descriptions.descriptions.get(name) : undefined;
    const mark = name === current ? " (current)" : "";
    return `- ${name}${mark}${description === undefined ? "" : `: ${description}`}`;
  });
  return {
    kind: "listing",
    line: [
      ...(current === undefined ? [] : [`Output style: ${current}`, ""]),
      "Available styles:",
      ...listed,
      "",
      ...(descriptions.kind === "unlisted" ? [descriptions.line, ""] : []),
      "Usage: /output-style <style>",
    ].join("\n"),
  };
}

/**
 * What `/advisor <argument>` does on a session whose Claude Code attaches `attached` and offers
 * `advisors`: `off` applies `null`; an offered advisor applies; anything else, nothing included,
 * is the listing in Claude Code's own layout naming only an advisor that attaches, or, where it
 * offers none here, its own line as sent. `current` is the session's own value, shown where the
 * build does not report what attaches; `displayNameOf` names a model as Claude Code's own lines
 * name it.
 */
export function answerClaudeAdvisor(
  argument: string,
  current: string | null,
  attached: ClaudeAttachedAdvisor,
  advisors: ClaudeAdvisorChoices,
  displayNameOf: (model: string) => string,
): ClaudeCommandOutcome<string | null> {
  const requested = argument.toLowerCase();
  if (CLAUDE_ADVISOR_OFF_WORDS.has(requested)) {
    return { kind: "apply", value: null };
  }
  if (advisors.kind === "listed" && advisors.choices.includes(requested)) {
    return { kind: "apply", value: requested };
  }
  if (advisors.kind === "unoffered") {
    return { kind: "listing", line: advisors.line };
  }
  const shown =
    attached.kind === "attached" ? attached.model : attached.kind === "none" ? null : current;
  const header = `Advisor: ${shown === null ? "off" : displayNameOf(shown)}`;
  const choices =
    advisors.kind === "listed"
      ? `Usage: /advisor <${[...advisors.choices, "off"].join("|")}>`
      : advisors.line;
  return { kind: "listing", line: `${header}\n${choices}` };
}
