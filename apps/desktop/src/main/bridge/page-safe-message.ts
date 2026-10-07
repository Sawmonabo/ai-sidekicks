// What a failure may carry to the page. A failure the operating system raised names the files,
// folders and programs it was working on in its message (`ENOENT: no such file or directory, open
// '/Users/me/plan.pdf'`), and so does an error built over one, so neither message crosses: main's
// log keeps the whole message, and the page is handed a fixed one naming nothing. Every other
// failure is one main wrote and crosses by its own message. The renderer owns the words a screen
// shows for any of them.

import { describeFailure } from "#shared/failure-message.js";

/** The members that mark a failure the operating system raised, or a program main ran. */
const SYSTEM_FAILURE_MEMBERS = ["syscall", "path", "errno", "cmd"] as const;

/**
 * `failure`'s message as the page may read it: `systemSentence` for a failure the operating
 * system raised or one with such a failure among its causes, and otherwise its own message.
 */
export function pageSafeMessage(failure: unknown, systemSentence: string): string {
  return systemFailureIn(failure) === undefined ? describeFailure(failure) : systemSentence;
}

/** What crosses for a failure the operating system raised: no path, program or code. */
const SYSTEM_FAILURE_MESSAGE = "The operating system refused this request; main's log has why.";

/**
 * `failure` itself when it names nothing of the system's, so a refusal main wrote keeps its
 * message across, and otherwise an `Error` carrying a fixed message that names nothing.
 */
export function pageSafeFailure(failure: unknown): unknown {
  return systemFailureIn(failure) === undefined ? failure : new Error(SYSTEM_FAILURE_MESSAGE);
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
