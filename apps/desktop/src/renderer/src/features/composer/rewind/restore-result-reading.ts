// What an undo says in the flow: one row for one undo. The row names what went back in the
// words the undo's own entry points use (`Restored to before <…>`, `Files restored to before
// <…>`, `Restored to <snapshot name>`), then each asked-for part that did not go back with the
// daemon's reason, verbatim. When nothing went back the row says the undo failed and why. A
// resend that failed after its undo applied leads with the failed send and its cause, then
// says what went back.

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

/** The words for what went back: files alone read `Files restored`, anything with the conversation `Restored`. */
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
 * (`API cleanup`) keep it.
 */
function midSentence(words: string): string {
  const [first = "", second = ""] = words;
  if (second !== second.toLocaleLowerCase()) {
    return words;
  }
  return `${first.toLocaleLowerCase()}${words.slice(first.length)}`;
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
 * The daemon's reason for one part that did not go back.
 *
 * The result carries a reason for every asked-for part that did not apply; one without it
 * would draw a row that hides why, so it throws instead.
 */
function reasonFor(result: SessionRestoreFinished, part: SessionRestorePart): string {
  const failure = result.failures?.[part];
  if (failure === undefined) {
    throw new Error(
      `the undo result reports the ${part} not restored and carries no reason for it: ${JSON.stringify(result)}`,
    );
  }
  return failure.reason;
}
