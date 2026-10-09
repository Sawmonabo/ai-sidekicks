// One line written to the Claude Code process's stdin, bounded by the transport's request deadline,
// so a process that stops reading can never hold a run's start open; and one user-text write on a
// channel, settled as an attempt however the transport ends it.

import type { Writable } from "node:stream";

import type { OutboundText } from "../../../outbound-text.js";
import { scheduleUnrefTimer } from "./control-requests.js";
import { ClaudeRequestTimeoutError } from "./errors.js";
import {
  CLAUDE_REQUEST_DEADLINE_MS,
  type ClaudeProviderProcess,
  type ClaudeUserTextWriteAttempt,
} from "./transport.js";

/**
 * Writes one piece of text on a channel, turning a transport rejection into a failed attempt. A
 * rejection carries no claim about the bytes, so it is `indeterminate`, never `unsent`.
 */
export async function attemptClaudeFrameWrite(
  channel: ClaudeProviderProcess,
  outboundText: OutboundText,
  messageUuid: string,
): Promise<ClaudeUserTextWriteAttempt> {
  try {
    return await channel.sendUserText(outboundText, messageUuid);
  } catch (cause) {
    return { settled: "failed", delivery: "indeterminate", cause };
  }
}

/**
 * Writes `line` to the process's stdin. It is written once the stream accepts it, or once `drain`
 * fires when the stream pushed back; it fails when `deadlineMs` passes first or the stream closes
 * or errors first, as it does when the process exits. A stream that can no longer be written fails
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
      cancelDeadline();
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
    const cancelDeadline = scheduleUnrefTimer(() => {
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
