// A tool row's one-line heading, read once from the row: the tool's name, its declared kind, its
// elapsed time and its result chip. The card draws it, and a copy of a row
// the window let go reads its text from the same reading, so both say the same words.

import type { TranscriptRowContent } from "@ai-sidekicks/contracts/transcript/content";
import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";

import { formatDuration, formatWireString } from "#renderer/lib/wire/figures.js";
import { readWireString } from "#renderer/lib/wire/strings.js";
import { type ChipTone } from "#renderer/components/Chip/Chip.js";
import { projectedPayload, readWireCount } from "#renderer/store/session/events/wire-payload.js";
import { toolResultState, type ToolResultState } from "./kind.js";
import { readDeclaredToolKind, type ToolKindReading } from "./tool-kinds/vocabulary.js";

/** What a tool row's heading draws, read from the row and its body. */
export interface ToolRowHeading {
  /** The tool's name, wire-verbatim, or `undefined` where the row names none. */
  readonly toolName: string | undefined;
  /** The tool kind the row declares, or `undefined` where it declares none. */
  readonly toolKind: ToolKindReading | undefined;
  /** The elapsed time, formatted, or `undefined` while the row carries none. */
  readonly elapsed: string | undefined;
  /** The result chip, or `undefined` for a call that succeeded, which shows by absence. */
  readonly resultChip: { readonly label: string; readonly tone: ChipTone } | undefined;
}

/** What the heading draws in place of a tool name the row does not carry. */
export const ABSENT_TOOL_NAME_LABEL = "No tool name";

/** The heading a tool row draws. */
export function toolRowHeadingOf(
  row: TranscriptEventRow,
  content: TranscriptRowContent | undefined,
): ToolRowHeading {
  const payload = projectedPayload(row);
  const durationMs = readWireCount(payload, "durationMs");
  return {
    toolName: readWireString(payload["toolName"]),
    toolKind: readDeclaredToolKind(payload),
    elapsed: durationMs === undefined ? undefined : formatDuration(durationMs),
    resultChip: RESULT_STATE_CHIPS[toolResultState(row.type, content)],
  };
}

/** The heading's words as one line, in the order the card draws them, spaced as it spaces them. */
export function toolRowHeadingText(heading: ToolRowHeading): string {
  const toolKind = heading.toolKind;
  const kindWords =
    toolKind === undefined || toolKind.kind === "unrecognized"
      ? []
      : [
          ...(toolKind.serverLabel === undefined ? [] : [toolKind.serverLabel]),
          ...toolKind.argumentSummary,
        ].map(formatWireString);
  return [
    heading.toolName ?? ABSENT_TOOL_NAME_LABEL,
    ...kindWords,
    ...(heading.elapsed === undefined ? [] : [heading.elapsed]),
    ...(heading.resultChip === undefined ? [] : [heading.resultChip.label]),
  ].join(" ");
}

/** How each result state reads and which tone it takes; `undefined` draws no chip. */
const RESULT_STATE_CHIPS: Readonly<
  Record<ToolResultState, { label: string; tone: ChipTone } | undefined>
> = {
  // Red means a failure, amber means a person is needed; truncated and unreadable bodies are
  // neither, so they take the neutral chip. `ToolOutput` renders the one red body case, a stored
  // body that does not match its signature.
  running: { label: "Running", tone: "neutral" },
  ok: undefined,
  error: { label: "Error", tone: "failure" },
  truncated: { label: "Truncated", tone: "neutral" },
  "body-unavailable": { label: "Body unavailable", tone: "neutral" },
};
