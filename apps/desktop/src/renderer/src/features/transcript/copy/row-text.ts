// A whole row's text, read from the source the row is drawn from rather than from its drawing, so
// a selection copies the rows the window let go between its ends. Each kind gives what its card
// draws: a message row its body alone; a tool row and a system message their author, time and
// line, as their layout lays them out; a run group header its line.
//   - A reply's body is its live lane, else what it drew while the log held it, else the body the
//     log stores for it; an open tool row's output is its live lane, else its stored body.
//   - A body the log holds as its size alone is copied whole, as a copy reads it in full before it
//     builds, whether or not its control was pressed; never the control's words.
//   - Where the log holds no body for a row, the copy carries the words the row draws in its place
//     when it comes back, so a row is never dropped from a copy without saying so: an unread body
//     its badge, a turn recorded without content its sentence. A reasoning row's read is kept
//     nowhere but its drawing, and a row drawn again shows only its streaming tail, so it copies
//     that tail, or nothing.

import type { HydratedSessionEventContent } from "@ai-sidekicks/contracts/event/envelope";
import type { TranscriptRowContent } from "@ai-sidekicks/contracts/transcript/content";
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
import { type CopyFlavor, type SelectedPart } from "./conversation-selection.js";
import { replyCopyFlavorOf, type DrawnRowText } from "./drawn-reply-text.js";

/** Where a row's body is read from: the log's window, the live lanes, and how the list draws it. */
export interface RowBodySources {
  readonly transcriptWindow: TranscriptWindowModel;
  readonly reveal: RowRevealContextValue;
  /** A row's fold as the list hands it over, which says whether an open call's output is drawn. */
  readonly densityOf: (rowId: string) => TranscriptRowDensity;
}

/** What a row's text is read from: where its body is, its large body read in full, its clock. */
export interface RowTextSources extends RowBodySources {
  /**
   * A large body a copy read in full, by its row's id, or `undefined` where none was read, as in
   * a composition that reads no bodies; the row then copies its unread badge.
   */
  readonly fullBodyOf: (rowId: string) => HydratedSessionEventContent | undefined;
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
      const body = rowBodyOf(row, sources);
      if (body?.from === "drawing") {
        return { flavor: body.flavor, text: body.text.slice(0) };
      }
      const content = loggedContentOf(row, sources);
      const stored = storedBodyOf(content);
      return stored === undefined
        ? { flavor: "text", text: unreadBodyTextOf(content) }
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
      const body = rowBodyOf(row, sources);
      return plainPart([
        row.actor ?? describeRowKind("tool-call").label,
        clockTimeOf(row.timestamp, sources),
        ...supersededMark(isSuperseded),
        toolRowHeadingText(toolRowHeadingOf(row, row.content)),
        ...(body === undefined ? [] : [toolOutputTextOf(body, row, sources)]),
      ]);
    }
  }
}

/**
 * The ids of the rows among `rowKeys` whose text reads a body the log holds as its size alone, in
 * order: a reply with no drawing or lane, an open call with no lane. A copy reads each in full
 * before it builds; a folded call copies no output, so it reads none.
 */
export function largeBodyRowIdsOf(
  rowKeys: readonly string[],
  sources: RowBodySources,
): readonly string[] {
  return rowKeys.flatMap((rowKey) => {
    const row = sources.transcriptWindow.rowsByKey.get(rowKey);
    return row !== undefined &&
      !sources.transcriptWindow.systemMessageByRowId.has(row.id) &&
      rowBodyOf(row, sources)?.from === "log" &&
      row.content?.status === "large"
      ? [row.id]
      : [];
  });
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
 * Where a reply's body or an open call's output is read from for its text: what it draws, from a
 * live lane or as a reply last drew it, else the log.
 */
type RowBody =
  | { readonly from: "drawing"; readonly text: PublishedText; readonly flavor: CopyFlavor }
  | { readonly from: "log" };

/** Where `row`'s body is read from, or `undefined` for a folded call or a row with no body. */
function rowBodyOf(row: TranscriptEventRow, sources: RowBodySources): RowBody | undefined {
  switch (classifyTranscriptRow(row)?.kind) {
    case "agent-message": {
      const drawn = replyRowTextOf(row.id, sources.reveal);
      return drawn === undefined
        ? { from: "log" }
        : { from: "drawing", text: drawn.text, flavor: drawn.flavor };
    }
    case "tool-call": {
      const liveText = sources.reveal.publishedTextFor(row.id);
      const isOpen =
        isFoldableCall(row, liveText !== undefined) && sources.densityOf(row.id) === "expanded";
      return !isOpen
        ? undefined
        : liveText === undefined
          ? { from: "log" }
          : { from: "drawing", text: liveText, flavor: "text" };
    }
    default:
      return undefined;
  }
}

/** A row's body as the log holds it, a large one as the copy read it in full. */
function loggedContentOf(
  row: TranscriptEventRow,
  sources: RowTextSources,
): TranscriptRowContent | undefined {
  return row.content?.status === "large"
    ? (sources.fullBodyOf(row.id) ?? row.content)
    : row.content;
}

/** An open tool row's output without escape sequences, else the words drawn in its place. */
function toolOutputTextOf(body: RowBody, row: TranscriptEventRow, sources: RowTextSources): string {
  const content = body.from === "log" ? loggedContentOf(row, sources) : undefined;
  const output = body.from === "drawing" ? body.text : storedBodyOf(content);
  if (output === undefined) {
    return unreadBodyTextOf(content);
  }
  return carriesAnsiEscapes(output) ? withoutResidualEscapes(output.slice(0)) : output.slice(0);
}

/** The body the log stores, where it holds one. */
function storedBodyOf(content: TranscriptRowContent | undefined): PublishedText | undefined {
  return content?.status === "available" ? publishedTextOf(content.body) : undefined;
}

/** The words a row with no body to copy draws in its place. */
function unreadBodyTextOf(content: TranscriptRowContent | undefined): string {
  return content?.status === "unavailable" ? UNAVAILABLE_BODY_TITLE : UNREAD_BODY_TITLE;
}
