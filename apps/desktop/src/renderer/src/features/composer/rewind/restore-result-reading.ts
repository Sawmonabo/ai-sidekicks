// What an undo says in the flow: one row naming what went back in the words of the undo's
// entry points, then each asked-for part that did not go back with the daemon's reason
// verbatim. A resend that failed after its undo applied leads with the failed send and its
// cause.

import type {
  SessionRestoreFinished,
  SessionRestorePart,
  SessionRestoreResult,
  SessionRestoreScope,
} from "@ai-sidekicks/contracts";

/** Where an undo went back to: before one of your messages, or to a named snapshot. */
export type RestoreTarget =
  | { readonly kind: "message"; readonly firstWords: string }
  | { readonly kind: "snapshot"; readonly name: string };

/**
 * The flow row for a finished undo, or for an edit and resend whose send failed after its
 * undo applied.
 */
export function readRestoreResult(result: SessionRestoreResult, target: RestoreTarget): string {
  if (result.outcome === "resend-unapplied") {
    return `Resend failed · ${result.reason} · ${midSentence(restoredWords(target, "conversation-and-files"))}`;
  }
  switch (result.restored) {
    case "nothing":
      return ["Undo failed", ...distinctReasons(result, partsOf(result.requested))].join(" · ");
    case "conversation-and-files":
      return restoredWords(target, result.restored);
    case "conversation":
    case "files": {
      const applied = restoredWords(target, result.restored);
      if (result.requested === result.restored) {
        return applied;
      }
      const missing: SessionRestorePart =
        result.restored === "conversation" ? "files" : "conversation";
      return `${applied} · ${missing} not restored · ${reasonFor(result, missing)}`;
    }
  }
}

/** The words for what went back: `Files restored` for files alone, else `Restored`. */
function restoredWords(target: RestoreTarget, restored: SessionRestoreScope): string {
  const verb = restored === "files" ? "Files restored to" : "Restored to";
  if (target.kind === "message") {
    return `${verb} before ${target.firstWords}`;
  }
  return `${verb} ${midSentence(target.name)}`;
}

/**
 * Words as they read mid-sentence: the first letter lowercased, so a snapshot named `Before
 * the refactor` reads `Restored to before the refactor`. Words that open on an acronym
 * (`API cleanup`) or on the pronoun `I` (`I broke it`) keep it.
 */
function midSentence(words: string): string {
  const [first = "", second = ""] = words;
  if (second !== second.toLocaleLowerCase() || opensOnPronounI(first, second)) {
    return words;
  }
  return `${first.toLocaleLowerCase()}${words.slice(first.length)}`;
}

/** Whether the words open on the pronoun `I`, standing alone or before an apostrophe. */
function opensOnPronounI(first: string, second: string): boolean {
  return first === "I" && (second === "" || second === " " || second === "'" || second === "’");
}

function partsOf(scope: SessionRestoreScope): readonly SessionRestorePart[] {
  return scope === "conversation-and-files" ? ["conversation", "files"] : [scope];
}

/** Each failed part's reason once: two parts refused for one cause name it once. */
function distinctReasons(
  result: SessionRestoreFinished,
  parts: readonly SessionRestorePart[],
): string[] {
  return [...new Set(parts.map((part) => reasonFor(result, part)))];
}

/**
 * The daemon's reason for one asked-for part that did not go back. The result's schema refuses a
 * result that leaves such a part without one, so it is always there.
 */
function reasonFor(result: SessionRestoreFinished, part: SessionRestorePart): string {
  return result.failures![part]!.reason;
}
