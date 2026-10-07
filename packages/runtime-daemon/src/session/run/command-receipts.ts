// The command receipt's two-phase commit: a receipt is accepted, then claimed for execution by
// exactly one worker, then given its terminal status. Each phase is its own write, so a restart
// finds a claimed receipt with no terminal status in flight and never runs its command again.

import type { RunId } from "@ai-sidekicks/contracts/run/id";

import { DATABASE_NOW_SQL } from "../../database/statement.js";
import type { DatabaseWriter } from "../../database/writer.js";
import { mintUuidV7 } from "../../uuid-v7.js";

/** A command to record before anything runs it; `commandId` is the client's idempotency key. */
export interface CommandToReceive {
  readonly commandId: string;
  readonly runId: RunId | null;
}

/** The receipt's status at acceptance: a refused command is recorded `rejected` and never run. */
export type CommandAcceptance = "accepted" | "rejected";

/** The receipt's status once its command has run. */
export type CommandOutcome = "completed" | "failed";

const ACCEPT_SQL = `INSERT INTO command_receipts (id, command_id, run_id, status, created_at)
  VALUES (@id, @command_id, @run_id, @status, ${DATABASE_NOW_SQL})`;

// Only the first claim finds `started_at` empty, so only one worker changes the row.
const CLAIM_SQL = `UPDATE command_receipts
  SET started_at = ${DATABASE_NOW_SQL}
  WHERE id = ? AND started_at IS NULL`;

const COMPLETE_SQL = `UPDATE command_receipts
  SET status = @status, completed_at = ${DATABASE_NOW_SQL}
  WHERE id = @id AND started_at IS NOT NULL AND completed_at IS NULL`;

/** Writes the command receipts, each phase of a receipt in its own write. */
export class CommandReceiptStore {
  readonly #writer: DatabaseWriter;

  constructor(writer: DatabaseWriter) {
    this.#writer = writer;
  }

  /**
   * Records the command and returns its receipt id. Throws when the command id already has a
   * receipt, so a command is received once.
   */
  async accept(command: CommandToReceive, status: CommandAcceptance): Promise<string> {
    const receiptId = mintUuidV7();
    await this.#writer.write([
      {
        sql: ACCEPT_SQL,
        bindings: {
          id: receiptId,
          command_id: command.commandId,
          run_id: command.runId,
          status,
        },
        expectedRowCount: 1,
      },
    ]);
    return receiptId;
  }

  /**
   * Claims the receipt for execution; true only for the one caller that claimed it. A caller that
   * gets false runs nothing, because another worker owns the execution.
   */
  async claimForExecution(receiptId: string): Promise<boolean> {
    const [result] = await this.#writer.write([{ sql: CLAIM_SQL, bindings: [receiptId] }]);
    return result?.rowCount === 1;
  }

  /**
   * Records how the claimed command ended. Throws when the receipt was never claimed or already
   * has its terminal status.
   */
  async complete(receiptId: string, status: CommandOutcome): Promise<void> {
    await this.#writer.write([
      { sql: COMPLETE_SQL, bindings: { id: receiptId, status }, expectedRowCount: 1 },
    ]);
  }
}
