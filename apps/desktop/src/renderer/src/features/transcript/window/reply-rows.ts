// A reply is the text an agent wrote in one turn: its reply rows, read in log order, with the tool
// rows and the thinking between them left out. A turn ends where the person's next message lands,
// and each run and epoch keeps its own, so a helper's reply or a rewound one never joins another.
// The reply's foot, with its Copy of the whole reply, sits on its last reply row.

import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";

import { classifyTranscriptRow } from "../rows/kind.js";
import { PublishedKeyedList } from "./published-keyed-list.js";

/**
 * Each reply's rows over one log, kept across the log's appended stretches: a row joins the reply
 * it extends as it arrives, so an appended row costs its own reply. A reply that gains a row is a
 * new entry under its new foot, published once per read rather than once per row; every other
 * reply keeps its row list's identity.
 */
export class ReplyIndex {
  readonly #replies = new PublishedKeyedList<Reply, readonly string[]>(
    (reply) => reply.footRowId,
    (reply) => reply.rowIds,
  );
  /** The reply still open in each turn: its position among the replies, and its rows so far. */
  readonly #openReplyByTurn = new Map<string, OpenReply>();
  /** The open replies that gained a row since their list was last published. */
  readonly #grownReplies = new Set<OpenReply>();

  /** Fold one row in, after every row admitted before it. */
  public admit(row: TranscriptEventRow): void {
    const kind = classifyTranscriptRow(row)?.kind;
    if (kind === "user-message") {
      // The person's message starts the next turn for every agent it may reach. A grown reply
      // stays in the grown set, published at the next read.
      this.#openReplyByTurn.clear();
      return;
    }
    if (kind !== "agent-message") {
      return;
    }
    const turnKey = row.kind === "run" ? `${row.runId}:${String(row.epoch)}` : row.kind;
    const openReply = this.#openReplyByTurn.get(turnKey);
    if (openReply === undefined) {
      this.#openReplyByTurn.set(turnKey, {
        position: this.#replies.push({ footRowId: row.id, rowIds: [row.id] }),
        rowIds: [row.id],
        footRowId: row.id,
      });
      return;
    }
    // Copying the whole reply per row made a long reply cost the square of its length.
    openReply.rowIds.push(row.id);
    openReply.footRowId = row.id;
    this.#grownReplies.add(openReply);
  }

  /**
   * Take, for each reply whose rows equal the list `previous` held under its foot, that list, so a
   * window derived again from a whole log republishes an unmoved reply's list by identity.
   */
  public retainRowLists(previous: ReadonlyMap<string, readonly string[]>): void {
    this.#publishGrownReplies();
    for (let position = 0; position < this.#replies.length; position += 1) {
      const reply = this.#replies.at(position);
      const previousRowIds = reply === undefined ? undefined : previous.get(reply.footRowId);
      if (
        reply !== undefined &&
        previousRowIds !== undefined &&
        previousRowIds !== reply.rowIds &&
        previousRowIds.length === reply.rowIds.length &&
        previousRowIds.every((rowId, index) => rowId === reply.rowIds[index])
      ) {
        this.#replies.set(position, { footRowId: reply.footRowId, rowIds: previousRowIds });
      }
    }
  }

  /**
   * Each reply's rows, keyed by the row that carries the reply's foot: the last of them. A row that
   * is no reply's last carries no foot and has no entry.
   */
  public replyRowIdsByFootRowId(): ReadonlyMap<string, readonly string[]> {
    this.#publishGrownReplies();
    return this.#replies.map();
  }

  // A copy, so a list once published never changes under its reader.
  #publishGrownReplies(): void {
    for (const openReply of this.#grownReplies) {
      this.#replies.set(openReply.position, {
        footRowId: openReply.footRowId,
        rowIds: openReply.rowIds.slice(),
      });
    }
    this.#grownReplies.clear();
  }
}

/** Each reply's rows by its foot row, for a caller that reads a log once. */
export function replyRowIdsByFootRowId(
  rows: readonly TranscriptEventRow[],
): ReadonlyMap<string, readonly string[]> {
  const replyIndex = new ReplyIndex();
  for (const row of rows) {
    replyIndex.admit(row);
  }
  return replyIndex.replyRowIdsByFootRowId();
}

/** A reply its turn may still extend: where it stands among the replies, and its rows so far. */
interface OpenReply {
  readonly position: number;
  readonly rowIds: string[];
  footRowId: string;
}

/** One reply: its rows in log order, and the last of them, which carries the foot. */
interface Reply {
  readonly footRowId: string;
  readonly rowIds: readonly string[];
}
