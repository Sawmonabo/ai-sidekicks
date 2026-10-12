// The events a selection in the conversation runs across, for a copy of rows the store let go: the
// first event its start row is drawn from and the last its end row is drawn from, noted while the
// log holds them, or an end of the conversation, the stream's newest event as the copy is asked
// for at its end, and the events between, read when the copy is asked for, from the store where it
// holds them and back through `transcript.read` where it does not: before and after what it holds,
// and in each stretch it let go between, as a long run's calls cut from its window. The store keeps
// only the rows its window holds, so a long selection costs memory only while its copy is read.

import type { EventCursor } from "@ai-sidekicks/contracts/session/event-cursor";
import { TRANSCRIPT_READ_LIMIT_MAX } from "@ai-sidekicks/contracts/transcript/limits";

import { RefusalError } from "#renderer/lib/refusal/contract.js";
import {
  readTranscriptPage,
  type TranscriptPageRead,
} from "#renderer/services/daemon/transcript/page.js";
import { heldIdAsWireId } from "#renderer/services/daemon/wire/identifiers.js";
import type { ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import type { SessionStoreState } from "#renderer/store/session/state.js";
import { type RowSelection, type RowSelectionBoundary } from "../viewport/selection/record.js";
import { type RowSourceSpan } from "../window/row-sources.js";

/** One event an end of a selection is drawn from: its place in the log and the cursor it is at. */
export interface SelectionEndEvent {
  readonly sequence: number;
  readonly cursor: EventCursor;
}

/** The first event of a selection's start row and the last event of its end row. */
export interface SelectionEventSpan {
  /** The start event's place in the log; `-Infinity` from the conversation's start. */
  readonly start: Pick<SelectionEndEvent, "sequence">;
  readonly end: SelectionEndEvent;
}

/**
 * The store's log as a copy found it: its events, oldest first, the read before the first, and the
 * stretches it let go between them.
 */
export interface HeldTranscript {
  readonly events: readonly ProjectedSessionEvent[];
  /** The cursor a read before the oldest held event is asked with; `undefined` at the start. */
  readonly headCursor: EventCursor | undefined;
  /** The stretches let go between held events, in log order. */
  readonly releasedStretches: readonly ReleasedEventStretch[];
}

/** One stretch the store let go inside the log it holds, as the store names it. */
export type ReleasedEventStretch = SessionStoreState["releasedStretches"][number];

/** What a copy reads the events of its selection with. */
export interface SelectedEventsRead {
  readonly readPage: TranscriptPageRead;
  readonly sessionId: string;
  /** Whether this copy is still the newest; a newer one stops its reads. */
  readonly isCurrent: () => boolean;
}

/**
 * The events a selection's ends are drawn from, noted each time the record changes, while the log
 * holds the rows they sit in. An end whose row the log no longer holds keeps what was noted for it.
 */
export class SelectionEventSpanRecord {
  #start: NotedEnd | undefined;
  #end: NotedEnd | undefined;

  /** Notes `selection`'s ends from the rows `spanOf` reads them from; `undefined` forgets both. */
  public note(
    selection: RowSelection | undefined,
    spanOf: (rowKey: string) => RowSourceSpan | undefined,
  ): void {
    if (selection === undefined) {
      this.#start = undefined;
      this.#end = undefined;
      return;
    }
    this.#start = notedEnd(this.#start, selection.start, spanOf, "first");
    this.#end = notedEnd(this.#end, selection.end, spanOf, "last");
  }

  /**
   * The span noted for the record's ends, an end of the conversation's last event being
   * `conversationEnd`; `undefined` when either end's row was never held, or the end of the
   * conversation is not known.
   */
  public readSpan(conversationEnd: SelectionEndEvent | undefined): SelectionEventSpan | undefined {
    const start = this.#start;
    const end = this.#end;
    if (start === undefined || end === undefined) {
      return undefined;
    }
    const startEvent =
      start.at === "row"
        ? start.event
        : start.at === "conversation-start"
          ? CONVERSATION_START_EVENT
          : undefined;
    const endEvent =
      end.at === "row" ? end.event : end.at === "conversation-end" ? conversationEnd : undefined;
    return startEvent === undefined || endEvent === undefined
      ? undefined
      : { start: startEvent, end: endEvent };
  }
}

/**
 * Every event from `span`'s start to its end, oldest first: the ones `held` holds, and the rest
 * read back through `transcript.read`, a page at a time, before and after it and in each stretch
 * it let go between. `undefined` when a newer copy took over. Throws a `RefusalError` when a page
 * is refused, so no part is copied.
 */
export async function readSelectedEvents(
  span: SelectionEventSpan,
  held: HeldTranscript,
  read: SelectedEventsRead,
): Promise<readonly ProjectedSessionEvent[] | undefined> {
  const { start, end } = span;
  const heldFirst = held.events[0]?.sequence;
  const heldLast = held.events.at(-1)?.sequence;
  if (heldFirst === undefined || heldLast === undefined) {
    return await readBackward(end.cursor, start.sequence, read);
  }
  const before =
    start.sequence >= heldFirst
      ? []
      : await readBackward(
          end.sequence < heldFirst ? end.cursor : held.headCursor,
          start.sequence,
          read,
        );
  const after =
    end.sequence <= heldLast || before === undefined
      ? []
      : await readBackward(end.cursor, Math.max(start.sequence, heldLast + 1), read);
  if (before === undefined || after === undefined) {
    return undefined;
  }
  const releasedReads = await readReleasedStretches(span, held, read);
  if (releasedReads === undefined) {
    return undefined;
  }
  // Each stretch read back goes in before the first held event after it.
  const events = [...before];
  let readIndex = 0;
  const takeReleasedBefore = (sequence: number): void => {
    for (
      let released = releasedReads[readIndex];
      released !== undefined && released.lastHeldSequenceBefore < sequence;
      released = releasedReads[readIndex]
    ) {
      for (const releasedEvent of released.events) {
        events.push(releasedEvent);
      }
      readIndex += 1;
    }
  };
  for (const event of held.events) {
    takeReleasedBefore(event.sequence);
    if (event.sequence >= start.sequence && event.sequence <= end.sequence) {
      events.push(event);
    }
  }
  takeReleasedBefore(Infinity);
  for (const afterEvent of after) {
    events.push(afterEvent);
  }
  return events;
}

/** What an end of a selection was noted as: its row's event, or an end of the conversation. */
type NotedEnd =
  | { readonly at: "row"; readonly rowKey: string; readonly event: SelectionEndEvent }
  | { readonly at: "conversation-start" | "conversation-end" };

/** Where a read from the conversation's start reads down to: before every event. */
const CONVERSATION_START_EVENT: Pick<SelectionEndEvent, "sequence"> = {
  sequence: Number.NEGATIVE_INFINITY,
};

/**
 * What `boundary` is noted as: the `which` event of its row's span while the log holds it, what
 * `previous` noted for the same row once it does not, or an end of the conversation.
 */
function notedEnd(
  previous: NotedEnd | undefined,
  boundary: RowSelectionBoundary,
  spanOf: (rowKey: string) => RowSourceSpan | undefined,
  which: "first" | "last",
): NotedEnd | undefined {
  if (boundary.at !== "row") {
    return { at: boundary.at };
  }
  const span = spanOf(boundary.rowKey);
  if (span === undefined) {
    return previous?.at === "row" && previous.rowKey === boundary.rowKey ? previous : undefined;
  }
  return { at: "row", rowKey: boundary.rowKey, event: endEventOf(span[which]) };
}

/** The end event a row of the log names: its sequence and the cursor it is read at. */
function endEventOf(row: {
  readonly sequence: number;
  readonly cursor: EventCursor;
}): SelectionEndEvent {
  return { sequence: row.sequence, cursor: row.cursor };
}

/** The events of one stretch the store let go, read back, after the held event before it. */
interface ReleasedStretchRead {
  readonly lastHeldSequenceBefore: number;
  readonly events: readonly ProjectedSessionEvent[];
}

/**
 * The events of each stretch `held` let go that lies between `span`'s ends, each read back from
 * the first held event after it, or from the end where the end lies inside it, down to the
 * stretch's start or the span's, in log order; `undefined` when a newer copy took over.
 */
async function readReleasedStretches(
  span: SelectionEventSpan,
  held: HeldTranscript,
  read: SelectedEventsRead,
): Promise<ReleasedStretchRead[] | undefined> {
  const { start, end } = span;
  const reads: ReleasedStretchRead[] = [];
  // Stretches come in log order, so one walk through the held events finds what follows each.
  let heldIndex = 0;
  for (const stretch of held.releasedStretches) {
    const { lastHeldSequenceBefore, firstHeldCursorAfter } = stretch;
    if (lastHeldSequenceBefore >= end.sequence) {
      break;
    }
    while ((held.events[heldIndex]?.sequence ?? Infinity) <= lastHeldSequenceBefore) {
      heldIndex += 1;
    }
    const firstHeldSequenceAfter = held.events[heldIndex]?.sequence ?? Infinity;
    if (firstHeldSequenceAfter <= start.sequence) {
      continue;
    }
    const isEndInside = end.sequence < firstHeldSequenceAfter;
    const events = await readBackward(
      isEndInside ? end.cursor : firstHeldCursorAfter,
      Math.max(start.sequence, lastHeldSequenceBefore + 1),
      read,
    );
    if (events === undefined) {
      return undefined;
    }
    reads.push({
      lastHeldSequenceBefore,
      // A read from the held event after the stretch takes that event too, which is held.
      events: isEndInside
        ? events
        : events.filter((event) => event.sequence < firstHeldSequenceAfter),
    });
  }
  return reads;
}

/**
 * The events at or before `cursor` down to the one at `downToSequence`, oldest first, read a page
 * at a time; `undefined` when a newer copy took over between pages.
 */
async function readBackward(
  cursor: EventCursor | undefined,
  downToSequence: number,
  read: SelectedEventsRead,
): Promise<ProjectedSessionEvent[] | undefined> {
  // Newest page first; joined once, oldest first, at the end.
  const pages: ProjectedSessionEvent[][] = [];
  for (let next = cursor; next !== undefined; ) {
    const reply = await read.readPage({
      sessionId: heldIdAsWireId(read.sessionId),
      beforeCursor: next,
      limit: TRANSCRIPT_READ_LIMIT_MAX,
    });
    if (!read.isCurrent()) {
      return undefined;
    }
    if (reply.status === "refused") {
      throw new RefusalError(reply.refusal);
    }
    const page = readTranscriptPage(reply.value);
    pages.push(page.events.filter((event) => event.sequence >= downToSequence));
    const reachedStart = page.events.some((event) => event.sequence <= downToSequence);
    next = reachedStart || !page.edge.hasMore ? undefined : page.edge.cursor;
  }
  return pages.reverse().flat();
}
