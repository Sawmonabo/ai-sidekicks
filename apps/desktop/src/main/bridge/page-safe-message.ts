// What a failure may say to the page. A failure the operating system raised names the files,
// folders and programs it was working on in its message (`ENOENT: no such file or directory, open
// '/Users/me/plan.pdf'`), and so does an error built over one, so neither message crosses: the
// page reads what failed and the system's code, and main's log keeps the whole message. Every
// other failure is one main wrote for the page and crosses by its own message.

import { describeFailure } from "#shared/failure-message.js";

/** The members that mark a failure the operating system raised, or a program main ran. */
const SYSTEM_FAILURE_MEMBERS = ["syscall", "path", "errno", "cmd"] as const;

/**
 * `failure`'s message as the page may read it: `<what> failed (<code>).` for a failure the
 * operating system raised or one with such a failure among its causes, and otherwise its own
 * message.
 */
export function pageSafeMessage(what: string, failure: unknown): string {
  const systemFailure = systemFailureIn(failure);
  if (systemFailure === undefined) {
    return describeFailure(failure);
  }
  const { code } = systemFailure as { code?: unknown };
  return typeof code === "string" ? `${what} failed (${code}).` : `${what} failed.`;
}

/**
 * `failure` itself when the page may read its message, and otherwise an `Error` carrying
 * `pageSafeMessage`, so a refusal main wrote keeps its class across.
 */
export function pageSafeFailure(what: string, failure: unknown): unknown {
  return systemFailureIn(failure) === undefined
    ? failure
    : new Error(pageSafeMessage(what, failure));
}

/** The first failure the operating system raised in `failure`'s cause chain, if any. */
function systemFailureIn(failure: unknown): Error | undefined {
  const seen = new Set<unknown>();
  for (let current = failure; current instanceof Error && !seen.has(current); ) {
    if (SYSTEM_FAILURE_MEMBERS.some((member) => Object.hasOwn(current as Error, member))) {
      return current;
    }
    seen.add(current);
    current = current.cause;
  }
  return undefined;
}
