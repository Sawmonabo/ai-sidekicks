// What of an app diagnostic's text reaches the service's log: each text cut to its bound, a message
// with every quoted run taken out, since a message quotes the value it choked on (a string it could
// not parse, a name it could not find), a stack kept to its frames, whose first line repeats the
// message, and a script's address without its query or fragment. Main applies it to everything a
// window hands it; a window applies it before it holds a report, so what it holds is bounded too.

import {
  APP_DIAGNOSTIC_TEXT_BOUNDS,
  type AppErrorSource,
} from "@ai-sidekicks/contracts/daemon/app-diagnostic";

/** An error's texts, as the log takes them. */
export interface RedactedErrorParts {
  readonly name: string | null;
  readonly message: string;
  readonly stack: string | null;
  readonly source: AppErrorSource | null;
}

/** An error's name, message, stack and source, each redacted and cut to its bound. */
export function redactErrorParts(parts: RedactedErrorParts): RedactedErrorParts {
  const frames = parts.stack === null ? null : stackFrames(parts.stack);
  return {
    name: parts.name === null ? null : parts.name.slice(0, APP_DIAGNOSTIC_TEXT_BOUNDS.name),
    message: redactMessage(parts.message),
    stack: frames === null ? null : frames.slice(0, APP_DIAGNOSTIC_TEXT_BOUNDS.stack),
    source:
      parts.source === null
        ? null
        : {
            address: parts.source.address
              .split(/[?#]/, 1)[0]!
              .slice(0, APP_DIAGNOSTIC_TEXT_BOUNDS.address),
            line: parts.source.line,
            column: parts.source.column,
          },
  };
}

/** A message or a captured line's detail with every quoted run out, cut to its bound. */
export function redactMessage(message: string): string {
  // Every quote mark of any kind from the first to the last becomes one elided quote, so nested
  // and mixed quotes leave nothing of what they held; a lone apostrophe is left as it is.
  return message.replace(/["'`].*["'`]/s, '"…"').slice(0, APP_DIAGNOSTIC_TEXT_BOUNDS.message);
}

// The stack's frame lines, its `at …` lines; the lines before them are the name and message.
function stackFrames(stack: string): string | null {
  const frames = stack.split("\n").filter((line) => /^\s*at\s/.test(line));
  return frames.length === 0 ? null : frames.join("\n");
}
