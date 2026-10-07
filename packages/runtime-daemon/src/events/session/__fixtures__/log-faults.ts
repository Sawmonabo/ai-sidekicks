// Faults a test puts on the event log the way they happen in the daemon: a commit whose receipt
// arrives after a later one's, and a stored row that a write outside the append path broke.

import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { DatabaseWriter } from "../../../database/writer.js";

/** The append path's writer, as a log under test takes it. */
type AppendWriter = Pick<DatabaseWriter, "appendEvents" | "appendThinkingUpdate">;

/** A writer whose one append's receipt waits, and the hold on it. */
export interface HeldReceipt {
  readonly writer: AppendWriter;
  /** Resolves with the held append's sequences once it commits, before its receipt is given. */
  readonly committed: Promise<readonly number[]>;
  /** Gives the held append its receipt. */
  readonly release: () => void;
}

/**
 * A writer that commits every append at once but holds the receipt of append number
 * `heldAppend` (counting from one) until `release` runs, so the next append's arrives first.
 */
export function holdReceiptOfAppend(writer: AppendWriter, heldAppend: number): HeldReceipt {
  const { promise: committed, resolve: resolveCommitted } =
    Promise.withResolvers<readonly number[]>();
  const { promise: released, resolve: releaseReceipt } = Promise.withResolvers<void>();
  let appendCount = 0;
  return {
    writer: {
      appendEvents: async (events, statements) => {
        appendCount += 1;
        const isHeld = appendCount === heldAppend;
        const sequences = await writer.appendEvents(events, statements);
        if (isHeld) {
          resolveCommitted(sequences);
          await released;
        }
        return sequences;
      },
      appendThinkingUpdate: (event) => writer.appendThinkingUpdate(event),
    },
    committed,
    release: releaseReceipt,
  };
}

/** Overwrites one stored event's payload with text that is not JSON, so reading it fails. */
export async function breakStoredEvent(
  writer: Pick<DatabaseWriter, "write">,
  sessionId: SessionId,
  sequence: number,
): Promise<void> {
  await writer.write([
    {
      sql: "UPDATE session_events SET payload = 'not json' WHERE session_id = ? AND sequence = ?",
      bindings: [sessionId, sequence],
      expectedRowCount: 1,
    },
  ]);
}
