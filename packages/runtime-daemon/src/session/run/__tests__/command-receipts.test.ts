// The command receipt's claim admits exactly one worker, so a command is never run twice, and its
// terminal write closes the receipt so a restart does not find it in flight.

import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, expect, it } from "vitest";

import { RunIdSchema } from "@ai-sidekicks/contracts/run/id";

import {
  openScratchDatabase,
  type ScratchDatabase,
} from "../../../database/__fixtures__/scratch.js";
import { CommandReceiptStore } from "../command-receipts.js";

let database: ScratchDatabase;
let receipts: CommandReceiptStore;

beforeEach(async () => {
  database = await openScratchDatabase();
  receipts = new CommandReceiptStore(database.writer);
});

afterEach(async () => {
  await database.close();
});

it("lets exactly one of two claims run the command, and the terminal write closes the receipt", async () => {
  const receiptId = await receipts.accept(
    { commandId: randomUUID(), runId: RunIdSchema.parse(randomUUID()) },
    "accepted",
  );

  const claims = await Promise.all([
    receipts.claimForExecution(receiptId),
    receipts.claimForExecution(receiptId),
  ]);
  expect(claims.filter((claimed) => claimed)).toHaveLength(1);

  await receipts.complete(receiptId, "completed");
  const row = database.reader
    .prepare<
      [string],
      { status: string; started_at: string | null; completed_at: string | null }
    >("SELECT status, started_at, completed_at FROM command_receipts WHERE id = ?")
    .get(receiptId);
  expect(row?.status).toBe("completed");
  expect(row?.started_at).not.toBeNull();
  expect(row?.completed_at).not.toBeNull();
});
