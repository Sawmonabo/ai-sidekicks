// One line written to the Claude Code process's stdin, bounded by the transport's request deadline,
// so a process that stops reading can never hold a run's start open.

import type { Writable } from "node:stream";

import { ClaudeRequestTimeoutError } from "./errors.js";
import { CLAUDE_REQUEST_DEADLINE_MS, type ClaudeUserTextWriteAttempt } from "./transport.js";

/**
 * Writes `line` to the process's stdin. It is written once the stream accepts it, or once `drain`
 * fires when the stream pushed back; it fails when `deadlineMs` passes first or the stream closes or
 * errors first, as it does when the process exits. A stream that can no longer be written fails
 * `unsent`; any other failure is `indeterminate`, since the bytes were handed over.
 */
export function writeStdinLine(
  stdin: Writable,
  line: string,
  deadlineMs: number = CLAUDE_REQUEST_DEADLINE_MS,
): Promise<ClaudeUserTextWriteAttempt> {
  if (!stdin.writable) {
    return Promise.resolve({
      settled: "failed",
      delivery: "unsent",
      cause: new Error("The Claude Code process's stdin was closed before the frame was written"),
    });
  }
  if (stdin.write(line)) {
    return Promise.resolve({ settled: "written" });
  }
  return new Promise((resolve) => {
    const settle = (attempt: ClaudeUserTextWriteAttempt): void => {
      clearTimeout(deadline);
      stdin.off("drain", onDrain);
      stdin.off("close", onClose);
      stdin.off("error", onError);
      resolve(attempt);
    };
    const onDrain = (): void => {
      settle({ settled: "written" });
    };
    const onClose = (): void => {
      settle({
        settled: "failed",
        delivery: "indeterminate",
        cause: new Error("The Claude Code process's stdin closed before the frame was taken"),
      });
    };
    const onError = (error: Error): void => {
      settle({ settled: "failed", delivery: "indeterminate", cause: error });
    };
    const deadline = setTimeout(() => {
      settle({
        settled: "failed",
        delivery: "indeterminate",
        cause: new ClaudeRequestTimeoutError(
          `The Claude Code process did not take the frame within ${deadlineMs}ms`,
          deadlineMs,
        ),
      });
    }, deadlineMs);
    stdin.on("drain", onDrain);
    stdin.on("close", onClose);
    stdin.on("error", onError);
  });
}
