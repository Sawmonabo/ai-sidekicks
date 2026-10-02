// What an attach form holds and what makes it sendable. The console only refuses requests
// the contract's parser would reject (no non-whitespace character, or past `FILE_PATH_MAX_LEN`)
// and resolves nothing: normalization, containment and symlinks are daemon rules. The emptiness
// check reads a trimmed copy but the request carries the path as typed, since surrounding
// spaces are legal POSIX filename characters.

import { FILE_PATH_MAX_LEN } from "@ai-sidekicks/contracts";

/** What the dialog holds while it is open: the path, exactly as typed. */
export interface AttachFormState {
  /** Exactly what was typed. Never trimmed, normalized, or joined by this console. */
  readonly localPath: string;
}

/**
 * An empty form: nothing typed.
 *
 * @consumedBy the attach dialog, which opens and resets on it
 */
export const EMPTY_ATTACH_FORM: AttachFormState = { localPath: "" };

/**
 * Whether this form can be sent, and if not, what is missing. A verdict rather than a
 * boolean, so a disabled control can say why.
 */
export type AttachFormVerdict =
  | { readonly status: "sendable"; readonly localPath: string }
  | { readonly status: "incomplete"; readonly because: string };

/**
 * Read one form into the verdict the dialog sends by. Length is measured in code units, as the
 * contract's Zod `max` does; a UTF-8 byte count would refuse paths the daemon accepts.
 */
export function resolveAttachForm(form: AttachFormState): AttachFormVerdict {
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
