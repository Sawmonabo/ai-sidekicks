// What main writes of an error nothing handled, whether a window reported it or main had it: each
// text cut to the bound the service's log takes, the message with every quoted run taken out, since
// a message quotes the value it choked on (a string it could not parse, a name it could not
// find), the stack kept to its frames, whose first line repeats the message, and the script's
// address without its query or fragment.

import {
  APP_ERROR_TEXT_BOUNDS,
  type AppErrorRole,
  type AppErrorSource,
  type AppErrorThrown,
} from "@ai-sidekicks/contracts/daemon/app-error";

/** One error as main has it, before it is bounded and stripped. */
export interface UnhandledErrorParts {
  readonly kind: AppErrorThrown["kind"];
  readonly role: AppErrorRole;
  readonly name: string | null;
  readonly message: string;
  readonly stack: string | null;
  readonly source: AppErrorSource | null;
}

/** The record main writes of one error, stamped `at`. */
export function boundAppError(parts: UnhandledErrorParts, at: Date): AppErrorThrown {
  const frames = parts.stack === null ? null : stackFrames(parts.stack);
  return {
    kind: parts.kind,
    at: at.toISOString(),
    role: parts.role,
    name: parts.name === null ? null : parts.name.slice(0, APP_ERROR_TEXT_BOUNDS.name),
    message: withoutQuotedRuns(parts.message).slice(0, APP_ERROR_TEXT_BOUNDS.message),
    stack: frames === null ? null : frames.slice(0, APP_ERROR_TEXT_BOUNDS.stack),
    source:
      parts.source === null
        ? null
        : {
            address: parts.source.address
              .split(/[?#]/, 1)[0]!
              .slice(0, APP_ERROR_TEXT_BOUNDS.address),
            line: parts.source.line,
            column: parts.source.column,
          },
  };
}

/** What two records of one error share, so a repeat is told from a different error. */
export function fingerprintOf(record: AppErrorThrown): string {
  const firstFrame = record.stack?.split("\n", 1)[0] ?? "";
  return JSON.stringify([record.kind, record.role, record.name, record.message, firstFrame]);
}

// Every quote mark of any kind from the first to the last becomes one elided quote, so nested and
// mixed quotes leave nothing of what they held; a lone apostrophe is left as it is.
function withoutQuotedRuns(message: string): string {
  return message.replace(/["'`].*["'`]/s, '"…"');
}

// The stack's frame lines, its `at …` lines; the lines before them are the name and message.
function stackFrames(stack: string): string | null {
  const frames = stack.split("\n").filter((line) => /^\s*at\s/.test(line));
  return frames.length === 0 ? null : frames.join("\n");
}
