// What an attach form holds and what makes it sendable.
//
// PURE, AND SEPARATE FROM THE ACT FOR THAT REASON. Everything below is a function of
// what a user typed; nothing here reaches a bridge or holds a lifetime. The controller
// beside it owns both.
//
// THE CONSOLE VALIDATES TWO THINGS AND RESOLVES NOTHING. Resolution, containment,
// symlink following, case folding, and working-tree-boundary awareness are DAEMON
// rules, so this module never normalizes a path, never joins one, never decides whether
// two spellings name one place, and never asks whether a path exists. What it does is
// refuse to put a request on the wire that the contract's own parser would reject unread
// — an entry with no non-whitespace character, and one past `FILE_PATH_MAX_LEN` — because
// a refusal a person can act on beats a schema failure that names a member path.
//
// AND IT SENDS WHAT WAS TYPED, BYTE FOR BYTE. The emptiness guard READS a trimmed copy
// and the request carries the original: a leading or trailing space is a legal POSIX
// filename character, so a console that trimmed on the way out would attach a
// different directory from the one that was named — silently, and only for the paths
// where it matters.

import { FILE_PATH_MAX_LEN } from "@ai-sidekicks/contracts";

/** What the dialog holds while it is open: the path, exactly as typed. */
export interface AttachFormState {
  /** Exactly what was typed. Never trimmed, normalized, or joined by this console. */
  readonly localPath: string;
}

/** An empty form: nothing typed. */
export const EMPTY_ATTACH_FORM: AttachFormState = { localPath: "" };

/**
 * Whether this form can be sent, and if not, what is missing.
 *
 * A verdict rather than a boolean, because a disabled control with no sentence declines to
 * say why.
 */
export type AttachFormVerdict =
  | { readonly status: "sendable"; readonly localPath: string }
  | { readonly status: "incomplete"; readonly because: string };

/** One form read: the verdict on whether it can be sent. */
export interface AttachFormResolution {
  readonly verdict: AttachFormVerdict;
}

/** Read one form into the verdict the dialog sends by. */
export function resolveAttachForm(form: AttachFormState): AttachFormResolution {
  return { verdict: attachVerdictFor(form) };
}

/**
 * The verdict itself.
 *
 * THE LENGTH IS MEASURED IN CODE UNITS, WHICH IS WHAT THE CONTRACT MEASURES. Its cap
 * is a Zod `max` on the string, so this guard is exact rather than approximate — a
 * byte count over a UTF-8 encoding would refuse paths the daemon accepts.
 */
function attachVerdictFor(form: AttachFormState): AttachFormVerdict {
  if (form.localPath.trim().length === 0) {
    return { status: "incomplete", because: "Name the repository's path." };
  }
  if (form.localPath.length > FILE_PATH_MAX_LEN) {
    return {
      status: "incomplete",
      because: `That path is ${String(form.localPath.length)} characters. The wire accepts ${String(FILE_PATH_MAX_LEN)}.`,
    };
  }
  return { status: "sendable", localPath: form.localPath };
}
