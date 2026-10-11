// What of an app diagnostic's text reaches the service's log: each text cut to its bound with an
// ellipsis, a message with every quoted run taken out, since a message quotes the value it choked
// on (a string it could not parse, a name it could not find), a stack kept to its frames, whose
// first line repeats the message, and every address, the script's and each frame's, without its
// query or fragment, which can carry a token. Main applies it to everything a window hands it; a
// window applies it before it holds a report, so what it holds is bounded too.

import {
  APP_DIAGNOSTIC_TEXT_BOUNDS,
  type AppErrorSource,
} from "@ai-sidekicks/contracts/daemon/app-diagnostic";

import { elideText } from "../elide-text.js";

// A query or fragment mark follows a character of an address, never a space, a dot or a
// parenthesis, so a private method's name, `Log.#rotate`, is kept.
// A frame's address ends in its line and column, `…/index.js?token=x:12:5`: the query before them
// goes and they stay.
const FRAME_QUERY_BEFORE_POSITION = /(?<=[^\s.(])[?#][^\s()]*?(?=:\d+:\d+\)?$)/;

// A query in a frame with no line and column goes to the end of the address.
const FRAME_QUERY = /(?<=[^\s.(])[?#][^\s()]*/g;

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
    name: parts.name === null ? null : bounded(parts.name, APP_DIAGNOSTIC_TEXT_BOUNDS.name),
    message: redactMessage(parts.message),
    stack: frames === null ? null : bounded(frames, APP_DIAGNOSTIC_TEXT_BOUNDS.stack),
    source:
      parts.source === null
        ? null
        : {
            address: bounded(
              parts.source.address.split(/[?#]/, 1)[0]!,
              APP_DIAGNOSTIC_TEXT_BOUNDS.address,
            ),
            line: parts.source.line,
            column: parts.source.column,
          },
  };
}

/** A message or a captured line's detail with every quoted run out, cut to its bound. */
export function redactMessage(message: string): string {
  // Every quote mark of any kind from the first to the last becomes one elided quote, so nested
  // and mixed quotes leave nothing of what they held; a lone apostrophe is left as it is.
  return bounded(message.replace(/["'`].*["'`]/s, '"…"'), APP_DIAGNOSTIC_TEXT_BOUNDS.message);
}

/** `text` cut to `bound` characters, an ellipsis marking the cut and counted within it. */
export function bounded(text: string, bound: number): string {
  return elideText(text, bound, { ellipsisWithinBound: true });
}

// The stack's frame lines, its `at …` lines, each address in them without its query or fragment;
// the lines before them are the name and message.
function stackFrames(stack: string): string | null {
  const frames = stack
    .split("\n")
    .filter((line) => /^\s*at\s/.test(line))
    .map((line) => line.replace(FRAME_QUERY_BEFORE_POSITION, "").replace(FRAME_QUERY, ""));
  return frames.length === 0 ? null : frames.join("\n");
}
