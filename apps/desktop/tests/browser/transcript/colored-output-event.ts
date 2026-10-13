// A finished tool call and its output, for the suites that check how the feed draws a command's
// output: colored terminal text, which the feed formats before its row is drawn, or any text.

import { CONTENT_LENGTH_PAYLOAD_KEY } from "@ai-sidekicks/contracts/event/declared-variants";

import {
  PAGED_SESSION_ID,
  pagedSessionEventAt,
} from "#renderer/features/transcript/logs.test-support.js";
import type { ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import { projectedContentOf } from "#renderer/store/session/entities/projected-content.js";

/** The byte that starts a terminal escape: an output still drawn as its source shows it. */
export const ESCAPE: string = String.fromCodePoint(0x1b);

/** The paged log's event at `index`: a finished call with `length` characters of colored output. */
export function coloredOutputEventAt(index: number, length: number): ProjectedSessionEvent {
  const lines: string[] = [];
  for (let line = 0, total = 0; total < length; line += 1) {
    const text = `${ESCAPE}[3${String(line % 8)}mok${ESCAPE}[39m line ${String(line)}`;
    lines.push(text);
    total += text.length + 1;
  }
  return toolOutputEventAt(index, lines.join("\n").slice(0, length));
}

/** The paged log's event at `index`: a finished call whose output is `body`. */
export function toolOutputEventAt(index: number, body: string): ProjectedSessionEvent {
  return {
    ...pagedSessionEventAt(index),
    kind: "tool.result",
    payload: {
      sessionId: PAGED_SESSION_ID,
      toolName: "build",
      toolCallId: `call-${String(index)}`,
      [CONTENT_LENGTH_PAYLOAD_KEY]: new TextEncoder().encode(body).byteLength,
    },
    content: projectedContentOf({ status: "available", body }),
  };
}
