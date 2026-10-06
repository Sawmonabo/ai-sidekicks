// A reply is the text an agent wrote in one turn: its reply rows, read in log order, with the tool
// rows and the thinking between them left out. A turn ends where the person's next message lands,
// and each run and epoch keeps its own, so a helper's reply or a rewound one never joins another.
// The reply's foot, with its Copy of the whole reply, sits on its last reply row.

import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";

import { classifyTranscriptRow } from "../rows/kind.js";

/**
 * Each reply's rows, keyed by the row that carries the reply's foot: the last of them. A row that
 * is no reply's last carries no foot and has no entry.
 */
export function replyRowIdsByFootRowId(
  rows: readonly TranscriptEventRow[],
): ReadonlyMap<string, readonly string[]> {
  const replies: Reply[] = [];
  const openReplyByTurn = new Map<string, Reply>();
  for (const row of rows) {
    const kind = classifyTranscriptRow(row)?.kind;
    if (kind === "user-message") {
      // The person's message starts the next turn for every agent it may reach.
      openReplyByTurn.clear();
    } else if (kind === "agent-message") {
      const turnKey = row.kind === "run" ? `${row.runId}:${String(row.epoch)}` : row.kind;
      const openReply = openReplyByTurn.get(turnKey);
      if (openReply === undefined) {
        const reply: Reply = { rowIds: [row.id], footRowId: row.id };
        replies.push(reply);
        openReplyByTurn.set(turnKey, reply);
      } else {
        openReply.rowIds.push(row.id);
        openReply.footRowId = row.id;
      }
    }
  }
  return new Map(replies.map((reply) => [reply.footRowId, reply.rowIds]));
}

/** One reply as the walk gathers it: its rows so far, and the last of them. */
interface Reply {
  readonly rowIds: string[];
  footRowId: string;
}
