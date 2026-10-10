// A whole row's text, read from the source the row is drawn from rather than from its drawing, so
// a selection copies the rows the window let go between its ends. Each kind gives what its card
// draws: a message row its body alone; a tool row and a system message their author, time and
// line, as their layout lays them out; a run group header its line.
//   - A reply's body is its live lane, else what it drew while the log held it, else the body the
//     log stores for it; an open tool row's output is its live lane, else its stored body.
//   - Where the log holds no body for a row, the copy carries the words the row draws in its place
//     when it comes back, so a row is never dropped from a copy without saying so: an unread body
//     its badge, a turn recorded without content its sentence. A reasoning row's read is kept
//     nowhere but its drawing, and a row drawn again shows only its streaming tail, so it copies
//     that tail, or nothing.

import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";

import { formatClockTime, formatWireString } from "#renderer/lib/wire/figures.js";
import { readWireString } from "#renderer/lib/wire/strings.js";
import { projectedPayload } from "#renderer/store/session/events/wire-payload.js";
import { SUPERSEDED_MARK_LABEL } from "../components/TranscriptRowLayout/TranscriptRowLayout.js";
import { type RowRevealContextValue } from "../reveal/components/RowRevealProvider.js";
import { publishedTextOf, type PublishedText } from "../reveal/published-text.js";
import { carriesAnsiEscapes, withoutResidualEscapes } from "../rows/ansi/escape-sequences.js";
import { UNREAD_BODY_TITLE } from "../rows/bodies/MachineBody.js";
import { UNAVAILABLE_BODY_TITLE } from "../rows/bodies/UnavailableBody.js";
import { describeRowKind, classifyTranscriptRow, isFoldableCall } from "../rows/kind.js";
import { type TranscriptRowDensity } from "../rows/renderer.js";
import { reasoningTailOf } from "../rows/thinking/reasoning-reading.js";
import { toolRowHeadingOf, toolRowHeadingText } from "../rows/tool-heading.js";
import { userMessageTextOf } from "../rows/user-message.js";
import { runGroupHeadingOf, runGroupHeadingText } from "../runs/heading.js";
import { type TranscriptWindowModel } from "../window/transcript-window.js";
import { type SelectedPart } from "./conversation-selection.js";
import { replyCopyFlavorOf, type DrawnRowText } from "./drawn-reply-text.js";

/** What a row's text is read from: the log's window, the live lanes, and how the list draws it. */
export interface RowTextSources {
  readonly transcriptWindow: TranscriptWindowModel;
  readonly reveal: RowRevealContextValue;
  /** A row's fold as the list hands it over, which says whether an open call's output is drawn. */
  readonly densityOf: (rowId: string) => TranscriptRowDensity;
  /** The locale a row's time is written in. */
  readonly clockLocale: string;
}

/**
 * A whole row's text and the flavor it copies as, or `undefined` for a key the log no longer
 * holds or a row that draws no text.
 */
export function readRowText(rowKey: string, sources: RowTextSources): SelectedPart | undefined {
  const { transcriptWindow } = sources;
  const runGroup = transcriptWindow.runGroupByHeaderKey.get(rowKey);
  if (runGroup !== undefined) {
    return { flavor: "text", text: runGroupHeadingText(runGroupHeadingOf(runGroup)) };
  }
  const row = transcriptWindow.rowsByKey.get(rowKey);
  if (row === undefined) {
    return undefined;
  }
  const isSuperseded = transcriptWindow.supersededRowIds.has(row.id);
  const systemMessage = transcriptWindow.systemMessageByRowId.get(row.id);
  if (systemMessage !== undefined) {
    return plainPart([
      clockTimeOf(systemMessage.timestamp, sources),
      ...supersededMark(isSuperseded),
      systemMessage.label,
    ]);
  }
  const rowKind = classifyTranscriptRow(row);
  switch (rowKind?.kind) {
    case undefined:
      return undefined;
    case "user-message": {
      const message = userMessageTextOf(row);
      return message === undefined ? undefined : { flavor: "text", text: message };
    }
    case "agent-message": {
      const drawn = replyRowTextOf(row.id, sources.reveal);
      if (drawn !== undefined) {
        return { flavor: drawn.flavor, text: drawn.text.slice(0) };
      }
      const stored = storedBodyOf(row);
      return stored === undefined
        ? { flavor: "text", text: unreadBodyTextOf(row) }
        : {
            flavor: replyCopyFlavorOf(stored, readWireString(projectedPayload(row)["contentType"])),
            text: stored.slice(0),
          };
    }
    case "thinking": {
      const liveText = sources.reveal.publishedTextFor(row.id);
      const tail = liveText === undefined ? [] : reasoningTailOf(liveText);
      return tail.length === 0 ? undefined : plainPart(tail);
    }
    case "tool-call": {
      const liveText = sources.reveal.publishedTextFor(row.id);
      const isOpen =
        isFoldableCall(row, liveText !== undefined) && sources.densityOf(row.id) === "expanded";
      return plainPart([
        row.actor ?? describeRowKind("tool-call").label,
        clockTimeOf(row.timestamp, sources),
        ...supersededMark(isSuperseded),
        toolRowHeadingText(toolRowHeadingOf(row, row.content)),
        ...(isOpen ? [toolOutputTextOf(row, liveText)] : []),
      ]);
    }
  }
}

/**
 * The text a reply row draws, and the flavor it copies as: its live lane while one runs, else
 * what it drew while the log held it, else `undefined`.
 */
export function replyRowTextOf(
  rowId: string,
  reveal: RowRevealContextValue,
): DrawnRowText | undefined {
  const recorded = reveal.drawnReplyText.drawnTextOf(rowId);
  const live = reveal.publishedTextFor(rowId);
  if (live !== undefined) {
    return { text: live, flavor: recorded?.flavor ?? replyCopyFlavorOf(live) };
  }
  return recorded;
}

/** Lines of plain text, each on a line of its own, as a row's blocks are read. */
function plainPart(lines: readonly string[]): SelectedPart {
  return { flavor: "text", text: lines.join("\n") };
}

/** A row's time as its layout draws it. */
function clockTimeOf(timestamp: string, sources: RowTextSources): string {
  return formatWireString(formatClockTime(timestamp, sources.clockLocale));
}

/** The mark a superseded row draws above its body. */
function supersededMark(isSuperseded: boolean): readonly string[] {
  return isSuperseded ? [SUPERSEDED_MARK_LABEL] : [];
}

/**
 * An open tool row's output without escape sequences: its live lane, else its stored body, else
 * the words its body draws in their place.
 */
function toolOutputTextOf(row: TranscriptEventRow, liveText: PublishedText | undefined): string {
  const output = liveText ?? storedBodyOf(row);
  if (output === undefined) {
    return unreadBodyTextOf(row);
  }
  return carriesAnsiEscapes(output) ? withoutResidualEscapes(output.slice(0)) : output.slice(0);
}

/** The body the log stores for a row, where it was read and holds one. */
function storedBodyOf(row: TranscriptEventRow): PublishedText | undefined {
  return row.content?.status === "available" ? publishedTextOf(row.content.body) : undefined;
}

/** The words a row with no body to copy draws in its place. */
function unreadBodyTextOf(row: TranscriptEventRow): string {
  return row.content?.status === "unavailable" ? UNAVAILABLE_BODY_TITLE : UNREAD_BODY_TITLE;
}
